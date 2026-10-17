#include "VibeShotEffects.h"

#include "Components/SceneComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/GameInstance.h"
#include "Engine/StaticMesh.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Materials/MaterialInterface.h"
#include "UObject/ConstructorHelpers.h"
#include "VibeNetSubsystem.h"

namespace
{
	// scene/shotTrace.ts and scene/shotTraces.tsx.
	constexpr int32 PoolSize = 16;
	constexpr float LifetimeS = 0.14f;
	constexpr double BeamRadiusCm = 3.4;
	constexpr double ImpactRadiusCm = 11.0;
	// A local shot's beam when nothing is known about what it hits (the web's
	// LOCAL_SHOT_TRACE_MAX_DISTANCE, 80 m).
	constexpr double MaxRangeCm = 8000.0;
	// Where the beam leaves, relative to the eye in the aim's frame (forward, right, up): the web's
	// CAMERA_PSEUDO_MUZZLE_OFFSET (0.18 right, 0.12 down, 0.35 forward).
	const FVector MuzzleOffsetCm(35.0, 18.0, -12.0);

	FLinearColor Hex(uint32 Rgb)
	{
		return FLinearColor(FColor((Rgb >> 16) & 0xFF, (Rgb >> 8) & 0xFF, Rgb & 0xFF));
	}
	const FLinearColor MissColor = Hex(0x4fdcff);
	const FLinearColor WorldColor = Hex(0xff8a2b);
	const FLinearColor BodyColor = Hex(0xff9a5c);
	const FLinearColor HeadColor = Hex(0xff4b4b);

	// SHOT_RESOLUTION_* (shared/src/protocol.rs) and HIT_ZONE_HEAD.
	constexpr uint32 ResolutionMiss = 0;
	constexpr uint32 ResolutionPlayer = 1;
	constexpr uint32 HitZoneHead = 2;
}

AVibeShotEffects::AVibeShotEffects()
{
	PrimaryActorTick.bCanEverTick = true;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
}

void AVibeShotEffects::BeginPlay()
{
	Super::BeginPlay();
	UStaticMesh* Cylinder = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
	UStaticMesh* Sphere = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Sphere.Sphere"));
	UMaterialInterface* Base = LoadObject<UMaterialInterface>(nullptr, TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
	Pool.SetNum(PoolSize);
	for (int32 i = 0; i < PoolSize; ++i)
	{
		FTracer& T = Pool[i];
		T.Material = UMaterialInstanceDynamic::Create(Base, this);
		auto Make = [&](UStaticMesh* Mesh, const TCHAR* Prefix)
		{
			UStaticMeshComponent* C = NewObject<UStaticMeshComponent>(this, *FString::Printf(TEXT("%s%d"), Prefix, i));
			C->SetStaticMesh(Mesh);
			C->SetMaterial(0, T.Material);
			C->SetCollisionEnabled(ECollisionEnabled::NoCollision);
			C->SetCastShadow(false);
			C->SetMobility(EComponentMobility::Movable);
			C->SetupAttachment(RootComponent);
			C->SetVisibility(false);
			C->RegisterComponent();
			return C;
		};
		T.Beam = Make(Cylinder, TEXT("TracerBeam"));
		T.Impact = Make(Sphere, TEXT("TracerImpact"));
	}
	const UGameInstance* GameInstance = GetGameInstance();
	if (UVibeNetSubsystem* Net = GameInstance ? GameInstance->GetSubsystem<UVibeNetSubsystem>() : nullptr)
	{
		FrameHandle = Net->OnFrame.AddUObject(this, &AVibeShotEffects::OnFrame);
	}
}

void AVibeShotEffects::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
	const UGameInstance* GameInstance = GetGameInstance();
	if (UVibeNetSubsystem* Net = GameInstance ? GameInstance->GetSubsystem<UVibeNetSubsystem>() : nullptr)
	{
		Net->OnFrame.Remove(FrameHandle);
	}
	Super::EndPlay(EndPlayReason);
}

void AVibeShotEffects::OnFrame(const VlFrameView& Frame)
{
	LocalPlayerId = Frame.stats.player_id;
	for (size_t i = 0; i < Frame.event_count; ++i)
	{
		const VlEvent& E = Frame.events[i];
		const FVector P0(E.p0[0], E.p0[1], E.p0[2]);
		const FVector P1(E.p1[0], E.p1[1], E.p1[2]);
		// Rifle and cannon leave a trace; a meteor arrives from the sky (GameWorld.tsx, shotTraces.tsx).
		if (E.kind == VL_EVENT_LOCAL_SHOT && E.weapon != VL_WEAPON_METEOR)
		{
			// p0 is the eye, p1 the aim direction. The core knows no hit point until the server
			// answers, so the beam runs the web's local tracer length.
			const FVector Dir = P1.GetSafeNormal();
			const FRotator Aim = Dir.Rotation();
			const FVector Muzzle = P0 + Aim.RotateVector(MuzzleOffsetCm);
			Show(Muzzle, P0 + Dir * MaxRangeCm, MissColor, false);
		}
		else if (E.kind == VL_EVENT_SHOT_FIRED && E.player != LocalPlayerId && E.weapon != VL_WEAPON_METEOR)
		{
			const FLinearColor Color = E.a == ResolutionMiss ? MissColor
				: E.a == ResolutionPlayer ? (E.b == HitZoneHead ? HeadColor : BodyColor)
				: WorldColor;
			Show(P0, P1, Color, E.a != ResolutionMiss);
		}
	}
}

void AVibeShotEffects::Show(const FVector& From, const FVector& To, const FLinearColor& Color, bool bImpact)
{
	FTracer& T = Pool[Next];
	Next = (Next + 1) % Pool.Num();
	const FVector Span = To - From;
	const double Length = Span.Size();
	if (Length < 1.0)
	{
		return;
	}
	// The engine cylinder is 100 cm tall and 100 cm across, centred, along Z.
	T.Beam->SetWorldLocationAndRotation((From + To) * 0.5, FRotationMatrix::MakeFromZ(Span / Length).Rotator());
	T.Beam->SetWorldScale3D(FVector(2.0 * BeamRadiusCm / 100.0, 2.0 * BeamRadiusCm / 100.0, Length / 100.0));
	T.Beam->SetVisibility(true);
	T.Impact->SetWorldLocation(To);
	T.Impact->SetWorldScale3D(FVector(2.0 * ImpactRadiusCm / 100.0));
	T.Impact->SetVisibility(bImpact);
	T.Material->SetVectorParameterValue(TEXT("Color"), Color);
	T.Age = 0.0f;
	T.bActive = true;
}

void AVibeShotEffects::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	for (FTracer& T : Pool)
	{
		if (!T.bActive)
		{
			continue;
		}
		T.Age += DeltaSeconds;
		if (T.Age >= LifetimeS)
		{
			T.bActive = false;
			T.Beam->SetVisibility(false);
			T.Impact->SetVisibility(false);
		}
	}
}

int32 AVibeShotEffects::ActiveTracers() const
{
	int32 Count = 0;
	for (const FTracer& T : Pool)
	{
		Count += T.bActive ? 1 : 0;
	}
	return Count;
}
