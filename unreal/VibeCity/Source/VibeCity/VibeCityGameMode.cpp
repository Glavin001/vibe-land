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
#include "VibeLandNet.h"
#include "VibeNetSettings.h"
#include "VibeNetSubsystem.h"
#include "vibe_client_core.h"

namespace
{
	// The web client's sun (client/src/graphics/sunSky.ts): elevation 39.3°, azimuth 69.4°. The
	// toward-sun vector in server space is (cos el · sin az, sin el, cos el · cos az).
	constexpr float SunElevationDeg = 39.3f;
	constexpr float SunAzimuthDeg = 69.4f;
}

AVibeCityGameMode::AVibeCityGameMode()
{
	DefaultPawnClass = ASpectatorPawn::StaticClass();
}

void AVibeCityGameMode::StartPlay()
{
	Super::StartPlay();
	SpawnEnvironment();

	UWorld* World = GetWorld();
	Director = World->SpawnActor<AVibeCityDirector>();
	Director->OnCityBuilt.AddUObject(this, &AVibeCityGameMode::FrameCity);

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
	UWorld* World = GetWorld();
	FActorSpawnParameters Params;
	Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;

	// Sun: the light shines from the sun toward the ground. Toward-sun in server space, mapped to
	// Unreal axes with the client core's own conversion (vl_coords_pos_to_unreal).
	const float El = FMath::DegreesToRadians(SunElevationDeg);
	const float Az = FMath::DegreesToRadians(SunAzimuthDeg);
	float TowardSun[3];
	vl_coords_pos_to_unreal(FMath::Cos(El) * FMath::Sin(Az), FMath::Sin(El), FMath::Cos(El) * FMath::Cos(Az), TowardSun);
	const FVector SunDirection = FVector(TowardSun[0], TowardSun[1], TowardSun[2]).GetSafeNormal();
	ADirectionalLight* Sun = World->SpawnActor<ADirectionalLight>(FVector(0, 0, 10000), (-SunDirection).Rotation(), Params);
	if (UDirectionalLightComponent* Light = Cast<UDirectionalLightComponent>(Sun->GetLightComponent()))
	{
		Light->SetMobility(EComponentMobility::Movable);
		Light->SetIntensity(8.0f);
		Light->SetAtmosphereSunLight(true);
	}

	AActor* Sky = World->SpawnActor<AActor>(AActor::StaticClass(), FTransform::Identity, Params);
	USkyAtmosphereComponent* Atmosphere = NewObject<USkyAtmosphereComponent>(Sky);
	Sky->SetRootComponent(Atmosphere);
	Atmosphere->RegisterComponent();

	ASkyLight* SkyLight = World->SpawnActor<ASkyLight>(FVector::ZeroVector, FRotator::ZeroRotator, Params);
	if (USkyLightComponent* Light = SkyLight->GetLightComponent())
	{
		Light->SetMobility(EComponentMobility::Movable);
		Light->bRealTimeCapture = true;
		Light->SetIntensity(1.0f);
		Light->RecaptureSky();
	}

	World->SpawnActor<AExponentialHeightFog>(FVector::ZeroVector, FRotator::ZeroRotator, Params);

	// Ground: the city world is flat at server y = 0 (Unreal z = 0), ±256 m.
	if (UStaticMesh* Plane = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Plane.Plane")))
	{
		AStaticMeshActor* Ground = World->SpawnActor<AStaticMeshActor>(FVector::ZeroVector, FRotator::ZeroRotator, Params);
		Ground->SetMobility(EComponentMobility::Movable);
		Ground->GetStaticMeshComponent()->SetStaticMesh(Plane);
		Ground->SetActorScale3D(FVector(512.0, 512.0, 1.0)); // the plane is 100 cm square
	}
}

void AVibeCityGameMode::FrameCity(const FBox& Bounds)
{
	APlayerController* Controller = UGameplayStatics::GetPlayerController(this, 0);
	APawn* Pawn = Controller ? Controller->GetPawn() : nullptr;
	if (!Pawn || !Bounds.IsValid)
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
