// VibeCity.Gamepad: a gamepad plays as on the web (input/gamepad.ts, bindings.ts DEFAULT_BINDINGS.gamepad,
// inputSettings.ts DEFAULT_INPUT_SETTINGS.gamepad), driven through Slate's analog and button events,
// the path a real controller's input takes:
//  * the left stick pushed fully forward sends move (0, 1) (radial deadzone 0.18, rescaled to the rim);
//  * the right stick fully right turns the view at the gamepad yaw speed, 2.8 rad/s (160°/s), ±10%;
//  * RT asks the core to fire; A sends the jump bit;
//  * and a mouse click pressed and released within one frame fires (as the web's mousedown).
// Run in the game (scripts/unreal/play-tests.sh --only VibeCity.Gamepad).

#include "Engine/Engine.h"
#include "Engine/GameViewportClient.h"
#include "Engine/World.h"
#include "Framework/Application/SlateApplication.h"
#include "GameFramework/PlayerController.h"
#include "Kismet/GameplayStatics.h"
#include "Misc/AutomationTest.h"
#include "Tests/AutomationCommon.h"
#include "Widgets/SWindow.h"
#include "VibeCityPlayerController.h"
#include "VibePlayerPawn.h"
#include "vibe_client_core.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace
{
	UWorld* PadWorld()
	{
		for (const FWorldContext& Context : GEngine->GetWorldContexts())
		{
			if ((Context.WorldType == EWorldType::Game || Context.WorldType == EWorldType::PIE) && Context.World())
			{
				return Context.World();
			}
		}
		return nullptr;
	}

	AVibePlayerPawn* PadPawn() { return Cast<AVibePlayerPawn>(UGameplayStatics::GetPlayerPawn(PadWorld(), 0)); }

	void Axis(const FKey& Key, float Value)
	{
		FSlateApplication& Slate = FSlateApplication::Get();
		Slate.ProcessAnalogInputEvent(FAnalogInputEvent(Key, FModifierKeysState(), Slate.GetUserIndexForKeyboard(), false, 0, 0, Value));
	}

	void Button(const FKey& Key, bool bDown)
	{
		FSlateApplication& Slate = FSlateApplication::Get();
		const FKeyEvent Event(Key, FModifierKeysState(), Slate.GetUserIndexForKeyboard(), false, 0, 0);
		bDown ? Slate.ProcessKeyDownEvent(Event) : Slate.ProcessKeyUpEvent(Event);
	}

	/** Holds a stick or trigger at a value for some seconds, resending each frame as a pad does. */
	class FHoldAxis : public IAutomationLatentCommand
	{
	public:
		FHoldAxis(FKey InKey, float InValue, double InSeconds) : Key(InKey), Value(InValue), Seconds(InSeconds) {}
		virtual bool Update() override
		{
			if (Started == 0.0)
			{
				Started = FPlatformTime::Seconds();
			}
			Axis(Key, Value);
			return FPlatformTime::Seconds() - Started >= Seconds;
		}
	private:
		FKey Key;
		float Value;
		double Seconds;
		double Started = 0.0;
	};
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FVibeCityGamepad, "VibeCity.Gamepad",
	EAutomationTestFlags::ClientContext | EAutomationTestFlags::ProductFilter)

bool FVibeCityGamepad::RunTest(const FString& Parameters)
{
	struct FState
	{
		double YawStart = 0.0;
		double TurnStart = 0.0;
		int32 FiresBefore = 0;
	};
	TSharedRef<FState> S = MakeShared<FState>();

	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Started = FPlatformTime::Seconds()]()
	{
		const AVibePlayerPawn* P = PadPawn();
		if (P && P->IsJoined())
		{
			if (AVibeCityPlayerController* PC = Cast<AVibeCityPlayerController>(UGameplayStatics::GetPlayerController(PadWorld(), 0)))
			{
				PC->CaptureCursor();
			}
			return true;
		}
		if (FPlatformTime::Seconds() - Started > 60.0)
		{
			AddError(TEXT("never joined"));
			return true;
		}
		return false;
	}));
	// Left stick forward.
	ADD_LATENT_AUTOMATION_COMMAND(FHoldAxis(EKeys::Gamepad_LeftY, 1.0f, 0.5));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this]()
	{
		const AVibePlayerPawn* P = PadPawn();
		const FVector2D Move = P ? P->SentMove() : FVector2D::ZeroVector;
		AddInfo(FString::Printf(TEXT("left stick forward: sent move (%.2f, %.2f)"), Move.X, Move.Y));
		TestTrue(TEXT("the left stick forward sends move (0, 1)"), FMath::IsNearlyEqual(Move.Y, 1.0, 0.02) && FMath::Abs(Move.X) < 0.02);
		Axis(EKeys::Gamepad_LeftY, 0.0f);
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(0.3f));
	// Right stick right for a second.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([S]()
	{
		const APlayerController* PC = UGameplayStatics::GetPlayerController(PadWorld(), 0);
		S->YawStart = PC ? PC->GetControlRotation().Yaw : 0.0;
		S->TurnStart = FPlatformTime::Seconds();
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FHoldAxis(EKeys::Gamepad_RightX, 1.0f, 1.0));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S]()
	{
		Axis(EKeys::Gamepad_RightX, 0.0f);
		const APlayerController* PC = UGameplayStatics::GetPlayerController(PadWorld(), 0);
		const double Seconds = FPlatformTime::Seconds() - S->TurnStart;
		const double Turned = FRotator::NormalizeAxis((PC ? PC->GetControlRotation().Yaw : 0.0) - S->YawStart);
		const double Rate = Turned / Seconds;
		const double Expected = FMath::RadiansToDegrees(2.8);
		AddInfo(FString::Printf(TEXT("right stick right: turned %.1f° in %.2f s (%.1f°/s; the web's %.1f°/s)"), Turned, Seconds, Rate, Expected));
		TestTrue(FString::Printf(TEXT("the right stick turns right at 2.8 rad/s (%.1f°/s)"), Rate), Rate > Expected * 0.9 && Rate < Expected * 1.1);
		S->FiresBefore = PadPawn() ? PadPawn()->FireRequests() : 0;
		return true;
	}));
	// RT fires.
	ADD_LATENT_AUTOMATION_COMMAND(FHoldAxis(EKeys::Gamepad_RightTriggerAxis, 1.0f, 0.4));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S]()
	{
		const int32 Fires = (PadPawn() ? PadPawn()->FireRequests() : 0) - S->FiresBefore;
		AddInfo(FString::Printf(TEXT("RT: %d fire requests"), Fires));
		TestTrue(TEXT("RT fires"), Fires > 0);
		return true;
	}));
	// RT released (a pad sends its value each frame; a lone 0 in the frame of the last 1 is averaged away).
	ADD_LATENT_AUTOMATION_COMMAND(FHoldAxis(EKeys::Gamepad_RightTriggerAxis, 0.0f, 0.2));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([]()
	{
		Button(EKeys::Gamepad_FaceButton_Bottom, true);
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(0.3f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this]()
	{
		TestTrue(TEXT("A sends the jump bit"), PadPawn() && (PadPawn()->SentButtons() & VL_BTN_JUMP) != 0);
		Button(EKeys::Gamepad_FaceButton_Bottom, false);
		return true;
	}));
	// A click pressed and released within one frame still fires, as the web's mousedown does
	// (a quick click at a low frame rate). Past the rifle's fire interval first.
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(0.5f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([S]()
	{
		S->FiresBefore = PadPawn() ? PadPawn()->FireRequests() : 0;
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(0.3f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S]()
	{
		const int32 Idle = (PadPawn() ? PadPawn()->FireRequests() : 0) - S->FiresBefore;
		AddInfo(FString::Printf(TEXT("nothing held: %d fire requests"), Idle));
		TestEqual(TEXT("with RT released and no button down, nothing fires"), Idle, 0);
		S->FiresBefore = PadPawn() ? PadPawn()->FireRequests() : 0;
		FSlateApplication& Slate = FSlateApplication::Get();
		UGameViewportClient* Viewport = GEngine->GameViewport;
		TSharedPtr<SWindow> Window = Viewport ? Viewport->GetWindow() : nullptr;
		if (Window)
		{
			const FVector2D At = Slate.GetCursorPos();
			Slate.ProcessMouseButtonDownEvent(Window->GetNativeWindow(), FPointerEvent(Slate.GetUserIndexForMouse(), FSlateApplication::CursorPointerIndex,
				At, At, TSet<FKey>({ EKeys::LeftMouseButton }), EKeys::LeftMouseButton, 0.0f, FModifierKeysState()));
			Slate.ProcessMouseButtonUpEvent(FPointerEvent(Slate.GetUserIndexForMouse(), FSlateApplication::CursorPointerIndex,
				At, At, TSet<FKey>(), EKeys::LeftMouseButton, 0.0f, FModifierKeysState()));
		}
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(0.3f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S]()
	{
		const int32 Fires = (PadPawn() ? PadPawn()->FireRequests() : 0) - S->FiresBefore;
		AddInfo(FString::Printf(TEXT("one-frame click: %d fire requests"), Fires));
		TestEqual(TEXT("a click within one frame fires once"), Fires, 1);
		return true;
	}));
	return true;
}

#endif
