#include "VibeCityGameMode.h"

#include "Components/DirectionalLightComponent.h"
#include "Components/ExponentialHeightFogComponent.h"
#include "Components/SkyAtmosphereComponent.h"
#include "Components/SkyLightComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/DirectionalLight.h"
#include "Engine/ExponentialHeightFog.h"
#include "Engine/GameInstance.h"
#include "Engine/SkyLight.h"
#include "Engine/StaticMesh.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/World.h"
#include "GameFramework/PlayerController.h"
#include "GameFramework/SpectatorPawn.h"
#include "Components/SkyAtmosphereComponent.h"
#include "Engine/EngineTypes.h"
#include "Kismet/GameplayStatics.h"
#include "VibeCityDirector.h"
#include "VibeCityEnvironment.h"
#include "VibeCityHUD.h"
#include "VibeCityPlayerController.h"
#include "VibePlayerPawn.h"
#include "VibeDynamicBodies.h"
#include "VibeAudio.h"
#include "VibeRemotePlayers.h"
#include "VibeShotEffects.h"
#include "VibeVehicles.h"
#include "VibeLandNet.h"
#include "VibeNetSettings.h"
#include "VibeNetSubsystem.h"
#include "vibe_client_core.h"

AVibeCityGameMode::AVibeCityGameMode()
{
	DefaultPawnClass = AVibePlayerPawn::StaticClass();
	PlayerControllerClass = AVibeCityPlayerController::StaticClass();
	HUDClass = AVibeCityHUD::StaticClass();
}

bool AVibeCityGameMode::IsSpectating()
{
	// -VibeSpectate, or a scripted view (-VibeView=…): fly over the city instead of playing.
	FString View;
	return FParse::Param(FCommandLine::Get(), TEXT("VibeSpectate")) || FParse::Value(FCommandLine::Get(), TEXT("VibeView="), View);
}

UClass* AVibeCityGameMode::GetDefaultPawnClassForController_Implementation(AController* InController)
{
	return IsSpectating() ? ASpectatorPawn::StaticClass() : Super::GetDefaultPawnClassForController_Implementation(InController);
}

void AVibeCityGameMode::StartPlay()
{
	Super::StartPlay();
	SpawnEnvironment();

	UWorld* World = GetWorld();
	Director = World->SpawnActor<AVibeCityDirector>();
	Director->OnCityBuilt.AddUObject(this, &AVibeCityGameMode::FrameCity);
	World->SpawnActor<AVibeShotEffects>();
	World->SpawnActor<AVibeDynamicBodies>();
	World->SpawnActor<AVibeVehicles>();
	World->SpawnActor<AVibeAudio>();
	World->SpawnActor<AVibeRemotePlayers>();

	if (GetDefault<UVibeNetSettings>()->bAutoConnect)
	{
		if (UVibeNetSubsystem* Net = GetGameInstance()->GetSubsystem<UVibeNetSubsystem>())
		{
			FString Api, Match;
			UVibeNetSettings::Resolve(Api, Match);
			Net->Connect(Api, Match);
		}
	}
}

void AVibeCityGameMode::SpawnEnvironment()
{
	// Sun, atmosphere, sky light, fog, post-process and the catalog-textured ground (VibeLandCity).
	GetWorld()->SpawnActor<AVibeCityEnvironment>();
}

void AVibeCityGameMode::FrameCity(const FBox& Bounds)
{
	APlayerController* Controller = UGameplayStatics::GetPlayerController(this, 0);
	APawn* Pawn = Controller ? Controller->GetPawn() : nullptr;
	// A playing pawn stands where the server puts it; only a spectator is framed on the city.
	if (!Pawn || !Bounds.IsValid || !Pawn->IsA<ASpectatorPawn>())
	{
		return;
	}
	const FVector Center = Bounds.GetCenter();
	const double Radius = FMath::Max(Bounds.GetExtent().Size(), 2000.0);
	const FVector Eye = Center + FVector(-1.1 * Radius, -0.6 * Radius, 0.7 * Radius);
	const FRotator Look = (Center - Eye).Rotation();
	Pawn->SetActorLocation(Eye);
	Controller->SetControlRotation(Look);
	// An offscreen window (scripted captures) still feeds stray mouse deltas; hold the frame still.
	if (FParse::Param(FCommandLine::Get(), TEXT("RenderOffscreen")))
	{
		Controller->SetIgnoreLookInput(true);
		Controller->SetIgnoreMoveInput(true);
	}
	UE_LOG(LogVibeLand, Display, TEXT("camera framed on the city at %s"), *Eye.ToString());
}
