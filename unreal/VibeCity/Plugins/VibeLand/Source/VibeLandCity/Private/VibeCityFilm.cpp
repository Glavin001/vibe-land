#include "VibeCityFilm.h"

#include "Async/Async.h"
#include "Containers/Ticker.h"
#include "Engine/GameEngine.h"
#include "Framework/Application/SlateApplication.h"
#include "HAL/PlatformTime.h"
#include "IImageWrapper.h"
#include "IImageWrapperModule.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"
#include "RHICommandList.h"
#include "RHIGPUReadback.h"
#include "RenderingThread.h"
#include "Rendering/SlateRenderer.h"
#include "Slate/SceneViewport.h"
#include "Slate/SlateViewportProvider.h"
#include "Widgets/SViewport.h"
#include "Widgets/SWindow.h"

// The window's back buffer is copied to a staging texture as it is about to be presented, and mapped
// only once the GPU reports the copy done (polled at later presents): nothing waits on the GPU, which
// on one machine is shared with the server's physics. The engine's FFrameGrabber maps with a fence
// wait in the same frame, and on that shared GPU each capture stalled the game for ~0.3 s.
namespace
{
	constexpr int32 Slots = 8;

	struct FSlot
	{
		TUniquePtr<FRHIGPUTextureReadback> Readback;
		int32 Index = -1; // the frame it holds; -1 when free
		FIntPoint Size = FIntPoint::ZeroValue;
		EPixelFormat Format = PF_Unknown;
	};

	struct FRecorder
	{
		FTSTicker::FDelegateHandle Ticker;
		FDelegateHandle Present;
		SWindow* Window = nullptr;
		FString Dir;
		double Fps = 24.0;
		double Started = 0.0;
		int32 NextIndex = 0;
		int32 Requested = 0;
		// Render thread only.
		TArray<int32> Pending;
		FSlot Ring[Slots];
		int32 Copied = 0;
		int32 Dropped = 0;
		TAtomic<int32> Written{ 0 };
		TAtomic<int32> InFlight{ 0 };
		TAtomic<int32> Busy{ 0 }; // slots holding a copy
	};
	FRecorder* Recorder = nullptr;

	void Write(FRecorder& R, int32 Index, FIntPoint Size, TArray<FColor>&& Pixels)
	{
		const FString Path = R.Dir / FString::Printf(TEXT("frame_%05d.jpg"), Index);
		++R.InFlight;
		FRecorder* Owner = &R;
		Async(EAsyncExecution::ThreadPool, [Owner, Path, Size, Pixels = MoveTemp(Pixels)]()
		{
			IImageWrapperModule& Module = FModuleManager::GetModuleChecked<IImageWrapperModule>(TEXT("ImageWrapper"));
			TSharedPtr<IImageWrapper> Jpeg = Module.CreateImageWrapper(EImageFormat::JPEG);
			if (Jpeg && Jpeg->SetRaw(Pixels.GetData(), Pixels.Num() * sizeof(FColor), Size.X, Size.Y, ERGBFormat::BGRA, 8))
			{
				FFileHelper::SaveArrayToFile(Jpeg->GetCompressed(92), *Path);
				++Owner->Written;
			}
			--Owner->InFlight;
		});
	}

	/** Maps every finished copy (render thread). */
	void Collect(FRecorder& R)
	{
		for (FSlot& Slot : R.Ring)
		{
			if (Slot.Index < 0 || !Slot.Readback->IsReady())
			{
				continue;
			}
			int32 Pitch = 0;
			const uint8* Data = static_cast<const uint8*>(Slot.Readback->Lock(Pitch));
			TArray<FColor> Pixels;
			Pixels.SetNumUninitialized(Slot.Size.X * Slot.Size.Y);
			for (int32 Y = 0; Data && Y < Slot.Size.Y; ++Y)
			{
				FColor* Out = Pixels.GetData() + Y * Slot.Size.X;
				if (Slot.Format == PF_A2B10G10R10)
				{
					const uint32* Row = reinterpret_cast<const uint32*>(Data) + Y * Pitch;
					for (int32 X = 0; X < Slot.Size.X; ++X)
					{
						const uint32 P = Row[X];
						Out[X] = FColor(uint8((P & 0x3ff) >> 2), uint8(((P >> 10) & 0x3ff) >> 2), uint8(((P >> 20) & 0x3ff) >> 2), 255);
					}
				}
				else
				{
					const FColor* Row = reinterpret_cast<const FColor*>(Data) + Y * Pitch;
					FMemory::Memcpy(Out, Row, Slot.Size.X * sizeof(FColor));
					if (Slot.Format == PF_R8G8B8A8)
					{
						for (int32 X = 0; X < Slot.Size.X; ++X)
						{
							Swap(Out[X].R, Out[X].B);
						}
					}
					for (int32 X = 0; X < Slot.Size.X; ++X)
					{
						Out[X].A = 255;
					}
				}
			}
			Slot.Readback->Unlock();
			if (Data)
			{
				Write(R, Slot.Index, Slot.Size, MoveTemp(Pixels));
			}
			Slot.Index = -1;
			--R.Busy;
		}
	}

	void OnPresent(SWindow& Window, ISlateViewportProvider& Provider)
	{
		FRecorder* R = Recorder;
		if (!R || &Window != R->Window)
		{
			return;
		}
		Collect(*R);
		if (R->Pending.IsEmpty())
		{
			return;
		}
		FRHITexture* BackBuffer = Provider.GetBackBufferResource();
		const int32 Index = R->Pending.Pop();
		R->Pending.Reset(); // a late frame stands for those it covered
		FSlot* Free = nullptr;
		for (FSlot& Slot : R->Ring)
		{
			if (Slot.Index < 0)
			{
				Free = &Slot;
				break;
			}
		}
		if (!BackBuffer || !Free)
		{
			++R->Dropped;
			return;
		}
		FRHICommandListImmediate& RHICmdList = FRHICommandListExecutor::GetImmediateCommandList();
		Free->Size = BackBuffer->GetSizeXY();
		Free->Format = BackBuffer->GetFormat();
		Free->Index = Index;
		RHICmdList.Transition(FRHITransitionInfo(BackBuffer, ERHIAccess::Unknown, ERHIAccess::CopySrc));
		Free->Readback->EnqueueCopy(RHICmdList, BackBuffer, FIntVector::ZeroValue, 0, FIntVector(Free->Size.X, Free->Size.Y, 1));
		RHICmdList.Transition(FRHITransitionInfo(BackBuffer, ERHIAccess::CopySrc, ERHIAccess::Present));
		++R->Busy;
		++R->Copied;
	}
}

namespace VibeCityFilm
{
	bool Start(const FString& Dir, double Fps)
	{
		const UGameEngine* Engine = Cast<UGameEngine>(GEngine);
		if (Recorder || !Engine || !Engine->SceneViewport.IsValid() || !FSlateApplication::IsInitialized())
		{
			return false;
		}
		const TSharedPtr<SViewport> Widget = Engine->SceneViewport->GetViewportWidget().Pin();
		const TSharedPtr<SWindow> Window = Widget ? FSlateApplication::Get().FindWidgetWindow(Widget.ToSharedRef()) : nullptr;
		if (!Window)
		{
			return false;
		}
		FModuleManager::LoadModuleChecked<IImageWrapperModule>(TEXT("ImageWrapper"));
		IFileManager::Get().MakeDirectory(*Dir, /*Tree=*/true);
		Recorder = new FRecorder();
		Recorder->Window = Window.Get();
		Recorder->Dir = Dir;
		Recorder->Fps = FMath::Max(1.0, Fps);
		Recorder->Started = FPlatformTime::Seconds();
		for (FSlot& Slot : Recorder->Ring)
		{
			Slot.Readback = MakeUnique<FRHIGPUTextureReadback>(TEXT("VibeCityFilm"));
		}
		Recorder->Present = FSlateApplication::Get().GetRenderer()->OnBackBufferReadyToPresent().AddStatic(&OnPresent);
		Recorder->Ticker = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateLambda([](float)
		{
			FRecorder* R = Recorder;
			const int32 Due = FMath::FloorToInt((FPlatformTime::Seconds() - R->Started) * R->Fps);
			if (Due >= R->NextIndex)
			{
				R->NextIndex = Due + 1;
				++R->Requested;
				ENQUEUE_RENDER_COMMAND(VibeCityFilmRequest)([R, Due](FRHICommandListImmediate&) { R->Pending.Add(Due); });
			}
			return true;
		}));
		return true;
	}

	int32 Stop()
	{
		if (!Recorder)
		{
			return 0;
		}
		FRecorder* R = Recorder;
		FTSTicker::GetCoreTicker().RemoveTicker(R->Ticker);
		const double Until = FPlatformTime::Seconds() + 5.0;
		while (R->Busy > 0 && FPlatformTime::Seconds() < Until)
		{
			ENQUEUE_RENDER_COMMAND(VibeCityFilmCollect)([R](FRHICommandListImmediate& RHICmdList)
			{
				RHICmdList.SubmitCommandsHint();
				Collect(*R);
			});
			FlushRenderingCommands();
			FPlatformProcess::Sleep(0.005f);
		}
		FSlateApplication::Get().GetRenderer()->OnBackBufferReadyToPresent().Remove(R->Present);
		FlushRenderingCommands();
		while (R->InFlight > 0 && FPlatformTime::Seconds() < Until + 10.0)
		{
			FPlatformProcess::Sleep(0.01f);
		}
		const int32 Written = R->Written;
		UE_LOG(LogTemp, Display, TEXT("VibeCityFilm: %d frames requested, %d copied, %d dropped (no free slot), %d written"), R->Requested, R->Copied, R->Dropped, Written);
		Recorder = nullptr;
		FlushRenderingCommands();
		delete R;
		return Written;
	}

	bool IsRecording()
	{
		return Recorder != nullptr;
	}
}
