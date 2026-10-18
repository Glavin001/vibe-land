#include "VibeCityCapture.h"

#include "Camera/CameraActor.h"
#include "Camera/CameraComponent.h"
#include "EngineUtils.h"
#include "Engine/World.h"
#include "GameFramework/Pawn.h"
#include "GameFramework/PlayerController.h"
#include "HAL/IConsoleManager.h"
#include "vibe_client_core.h"

namespace
{
	// The game's hipfire field of view (vertical), as the web's.
	constexpr float GameFovDeg = 75.0f;
	const FName CaptureTag(TEXT("VibeCityCapture"));

	FVector ToUnreal(const FVector3f& P)
	{
		float Out[3];
		vl_coords_pos_to_unreal(P.X, P.Y, P.Z, Out);
		return FVector(Out[0], Out[1], Out[2]);
	}

	FAutoConsoleCommandWithWorldAndArgs GVibeCapture(
		TEXT("vibe.capture"),
		TEXT("vibe.capture px py pz tx ty tz [fov]: park the camera (server metres, vertical fov); no arguments releases it"),
		FConsoleCommandWithWorldAndArgsDelegate::CreateLambda([](const TArray<FString>& Args, UWorld* World) {
			if (Args.Num() < 6)
			{
				VibeCityCapture::Release(World);
				return;
			}
			const FString Joined = FString::Join(Args, TEXT(","));
			FVector3f P, T;
			float Fov = 0.0f;
			if (VibeCityCapture::Parse(Joined, P, T, Fov))
			{
				VibeCityCapture::Park(World, P, T, Fov);
			}
		}));
}

bool VibeCityCapture::Parse(const FString& Text, FVector3f& Position, FVector3f& LookAt, float& FovDeg)
{
	TArray<FString> Parts;
	Text.ParseIntoArray(Parts, TEXT(","));
	if (Parts.Num() != 6 && Parts.Num() != 7)
	{
		return false;
	}
	float V[7] = {};
	for (int32 i = 0; i < Parts.Num(); ++i)
	{
		V[i] = FCString::Atof(*Parts[i].TrimStartAndEnd());
		if (!FMath::IsFinite(V[i]))
		{
			return false;
		}
	}
	Position = FVector3f(V[0], V[1], V[2]);
	LookAt = FVector3f(V[3], V[4], V[5]);
	FovDeg = Parts.Num() == 7 ? V[6] : 0.0f;
	return true;
}

bool VibeCityCapture::Park(UWorld* World, const FVector3f& Position, const FVector3f& LookAt, float FovDeg)
{
	APlayerController* Controller = World ? World->GetFirstPlayerController() : nullptr;
	if (!Controller)
	{
		return false;
	}
	ACameraActor* Camera = nullptr;
	for (TActorIterator<ACameraActor> It(World); It; ++It)
	{
		if (It->Tags.Contains(CaptureTag))
		{
			Camera = *It;
		}
	}
	if (!Camera)
	{
		Camera = World->SpawnActor<ACameraActor>();
		if (!Camera)
		{
			return false;
		}
		Camera->Tags.Add(CaptureTag);
	}
	const FVector From = ToUnreal(Position), To = ToUnreal(LookAt);
	Camera->SetActorLocationAndRotation(From, (To - From).Rotation());
	UCameraComponent* Component = Camera->GetCameraComponent();
	// The web's field of view is vertical; a camera actor's is horizontal: convert at the
	// viewport's aspect.
	int32 Width = 16, Height = 9;
	Controller->GetViewportSize(Width, Height);
	const float Aspect = Height > 0 ? static_cast<float>(Width) / Height : 16.0f / 9.0f;
	const float VerticalRad = FMath::DegreesToRadians(FovDeg > 0.0f ? FovDeg : GameFovDeg);
	Component->bConstrainAspectRatio = false;
	Component->SetFieldOfView(FMath::RadiansToDegrees(2.0f * FMath::Atan(FMath::Tan(VerticalRad * 0.5f) * Aspect)));
	Controller->SetViewTarget(Camera);
	return true;
}

void VibeCityCapture::Release(UWorld* World)
{
	APlayerController* Controller = World ? World->GetFirstPlayerController() : nullptr;
	if (Controller && Controller->GetPawn())
	{
		Controller->SetViewTarget(Controller->GetPawn());
	}
}
