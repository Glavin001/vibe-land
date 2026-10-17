#include "VibeDynamicBodies.h"

#include "Components/DecalComponent.h"
#include "Components/PointLightComponent.h"
#include "EngineUtils.h"
#include "VibeCityDirector.h"
#include "Components/SceneComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/GameInstance.h"
#include "Engine/StaticMesh.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Materials/MaterialInterface.h"
#include "VibeNetSubsystem.h"

namespace
{
	// The engine's basic shapes are 100 cm across.
	constexpr double BasicShapeCm = 100.0;
	// The web's meteor: basalt with embers (vfx/MeteorLayer.tsx); a warm light that reads at range.
	// Fallback colours, for when the city materials (Scripts/import_city_materials.py) are absent.
	const FLinearColor BasaltColor(0.09f, 0.07f, 0.06f);
	const FLinearColor EmberColor(1.0f, 0.42f, 0.12f);
	const FLinearColor CannonballColor(0.12f, 0.12f, 0.13f);
	// The trail is the path the meteor covers in this long: a camera's motion streak at 1/8 s.
	constexpr double TrailExposureS = 0.125;
	// The incandescence of entry ends at impact; what glows after is the rock's skin cooling, drawn
	// fading with this time constant.
	constexpr double CoolingS = 0.75;
	constexpr float MeteorLightIntensity = 400000.0f;
	// A flight is kept this long past its flight time if its body never appears (out of interest).
	constexpr double FlightGraceS = 4.0;
}

AVibeDynamicBodies::AVibeDynamicBodies()
{
	PrimaryActorTick.bCanEverTick = true;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
}

UStaticMeshComponent* AVibeDynamicBodies::NewMesh(UStaticMesh* Mesh, UMaterialInterface* Material, const FString& Name)
{
	UStaticMeshComponent* C = NewObject<UStaticMeshComponent>(this, *Name);
	C->SetStaticMesh(Mesh);
	C->SetMaterial(0, Material);
	C->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	C->SetMobility(EComponentMobility::Movable);
	C->SetupAttachment(RootComponent);
	C->SetVisibility(false);
	C->RegisterComponent();
	return C;
}

void AVibeDynamicBodies::BeginPlay()
{
	Super::BeginPlay();
	SphereMesh = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Sphere.Sphere"));
	CubeMesh = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube"));
	UMaterialInterface* Base = LoadObject<UMaterialInterface>(nullptr, TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
	// Forged iron and glowing basalt (M_VibeCityCannonball, M_VibeCityMeteor), else flat colours.
	UMaterialInterface* Iron = LoadObject<UMaterialInterface>(nullptr, TEXT("/Game/VibeCity/Materials/M_VibeCityCannonball.M_VibeCityCannonball"));
	UMaterialInterface* Basalt = LoadObject<UMaterialInterface>(nullptr, TEXT("/Game/VibeCity/Materials/M_VibeCityMeteor.M_VibeCityMeteor"));
	ScorchBase = LoadObject<UMaterialInterface>(nullptr, TEXT("/Game/VibeCity/Materials/M_VibeCityScorch.M_VibeCityScorch"));
	TrailBase = LoadObject<UMaterialInterface>(nullptr, TEXT("/Game/VibeCity/Materials/M_VibeCityMeteorTrail.M_VibeCityMeteorTrail"));
	BallMaterial = UMaterialInstanceDynamic::Create(Iron ? Iron : Base, this);
	BallMaterial->SetVectorParameterValue(TEXT("Color"), CannonballColor);
	MeteorMaterial = UMaterialInstanceDynamic::Create(Basalt ? Basalt : Base, this);
	MeteorMaterial->SetVectorParameterValue(TEXT("Color"), BasaltColor);
	const UGameInstance* GameInstance = GetGameInstance();
	if (UVibeNetSubsystem* Net = GameInstance ? GameInstance->GetSubsystem<UVibeNetSubsystem>() : nullptr)
	{
		FrameHandle = Net->OnFrame.AddUObject(this, &AVibeDynamicBodies::OnFrame);
	}
}

void AVibeDynamicBodies::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
	const UGameInstance* GameInstance = GetGameInstance();
	if (UVibeNetSubsystem* Net = GameInstance ? GameInstance->GetSubsystem<UVibeNetSubsystem>() : nullptr)
	{
		Net->OnFrame.Remove(FrameHandle);
	}
	Super::EndPlay(EndPlayReason);
}

UStaticMeshComponent* AVibeDynamicBodies::Body(int32 Index, bool bSphere)
{
	TArray<TObjectPtr<UStaticMeshComponent>>& Pool = bSphere ? Spheres : Boxes;
	while (Pool.Num() <= Index)
	{
		Pool.Add(NewMesh(bSphere ? SphereMesh : CubeMesh, BallMaterial, FString::Printf(TEXT("%s%d"), bSphere ? TEXT("Ball") : TEXT("Box"), Pool.Num())));
	}
	return Pool[Index];
}

void AVibeDynamicBodies::OnFrame(const VlFrameView& Frame)
{
	const double Now = FPlatformTime::Seconds();
	for (size_t i = 0; i < Frame.meteor_count; ++i)
	{
		const VlMeteor& M = Frame.meteors[i];
		FFlight& F = Flights.FindOrAdd(M.body_id);
		F.Meteor = M;
		F.LaunchedAt = Now - M.age_s;
		if (!F.Mesh)
		{
			F.Material = UMaterialInstanceDynamic::Create(MeteorMaterial->Parent, this);
			F.Material->SetVectorParameterValue(TEXT("Color"), BasaltColor);
			F.Mesh = NewMesh(SphereMesh, F.Material, FString::Printf(TEXT("Meteor%u"), M.body_id));
			F.Light = NewObject<UPointLightComponent>(this);
			F.Light->SetupAttachment(F.Mesh);
			F.Light->SetLightColor(EmberColor);
			F.Light->SetIntensity(MeteorLightIntensity);
			F.Light->SetAttenuationRadius(6000.0f);
			F.Light->RegisterComponent();
			if (TrailBase)
			{
				F.TrailMaterial = UMaterialInstanceDynamic::Create(TrailBase, this);
				F.Trail = NewMesh(SphereMesh, F.TrailMaterial, FString::Printf(TEXT("MeteorTrail%u"), M.body_id));
				F.Trail->SetCastShadow(false);
			}
		}
		F.Mesh->SetWorldScale3D(FVector(2.0 * M.radius / BasicShapeCm));
	}

	int32 SphereCount = 0, BoxCount = 0;
	TSet<uint32> Present;
	for (size_t i = 0; i < Frame.dynamic_body_count; ++i)
	{
		const VlDynamicBody& B = Frame.dynamic_bodies[i];
		Present.Add(B.body_id);
		const FVector Pos(B.pos[0], B.pos[1], B.pos[2]);
		const FQuat Rot(B.quat[0], B.quat[1], B.quat[2], B.quat[3]);
		if (FFlight* F = Flights.Find(B.body_id))
		{
			// The meteor's own body: drawn by its flight's mesh from now on, its velocity from the
			// last two poses.
			const double Dt = Now - F->LastPosAt;
			const FVector Velocity = Dt > 0.0 && F->LastPosAt > 0.0 ? (Pos - F->LastPos) / Dt : FVector::ZeroVector;
			PlaceMeteor(*F, Pos, Velocity);
			BodiesSeen.Add(B.body_id);
			continue;
		}
		const bool bSphere = B.shape == VL_SHAPE_SPHERE;
		UStaticMeshComponent* C = Body(bSphere ? SphereCount++ : BoxCount++, bSphere);
		C->SetWorldLocationAndRotation(Pos, Rot);
		C->SetWorldScale3D(FVector(B.half_extents[0], B.half_extents[1], B.half_extents[2]) * 2.0 / BasicShapeCm);
		C->SetVisibility(true);
	}
	for (int32 i = SphereCount; i < Spheres.Num(); ++i)
	{
		Spheres[i]->SetVisibility(false);
	}
	for (int32 i = BoxCount; i < Boxes.Num(); ++i)
	{
		Boxes[i]->SetVisibility(false);
	}
	Shown = SphereCount + BoxCount;

	// A meteor whose body was drawn and has now left the snapshots (impact, removal) is done.
	for (auto It = Flights.CreateIterator(); It; ++It)
	{
		const bool bBodyGone = BodiesSeen.Contains(It.Key()) && !Present.Contains(It.Key());
		const bool bExpired = Now - It.Value().LaunchedAt > It.Value().Meteor.flight_time_s + FlightGraceS && !Present.Contains(It.Key());
		if (bBodyGone || bExpired)
		{
			It.Value().Light->DestroyComponent();
			It.Value().Mesh->DestroyComponent();
			if (It.Value().Trail)
			{
				It.Value().Trail->DestroyComponent();
			}
			BodiesSeen.Remove(It.Key());
			It.RemoveCurrent();
		}
	}
}

void AVibeDynamicBodies::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	const double Now = FPlatformTime::Seconds();
	for (TPair<uint32, FFlight>& Pair : Flights)
	{
		FFlight& F = Pair.Value;
		const double SinceImpact = Now - F.LaunchedAt - F.Meteor.flight_time_s;
		const float Heat = SinceImpact <= 0.0 ? 1.0f : static_cast<float>(FMath::Exp(-SinceImpact / CoolingS));
		F.Light->SetIntensity(MeteorLightIntensity * Heat);
		if (SinceImpact >= 0.0 && !F.bLanded)
		{
			Land(F);
		}
		F.Material->SetScalarParameterValue(TEXT("Glow"), Heat);
		if (F.Trail && SinceImpact > 0.0)
		{
			F.Trail->SetVisibility(false); // no more entry plasma
		}
		if (BodiesSeen.Contains(Pair.Key))
		{
			continue; // its body is being drawn
		}
		const VlMeteor& M = F.Meteor;
		const double T = FMath::Min(Now - F.LaunchedAt, static_cast<double>(M.flight_time_s));
		const FVector Start(M.start[0], M.start[1], M.start[2]);
		const FVector V(M.velocity[0], M.velocity[1], M.velocity[2]);
		const FVector G(M.gravity[0], M.gravity[1], M.gravity[2]);
		PlaceMeteor(F, Start + V * T + 0.5 * G * T * T, V + G * T);
	}
}

void AVibeDynamicBodies::Land(FFlight& F)
{
	F.bLanded = true;
	++LandingCount;
	const FVector At = F.Mesh->GetComponentLocation();
	const double Radius = F.Meteor.radius;
	// The surge rolls along the ground (the city's ground is the plane at height 0; the core's
	// collapse waves sit 0.3 m above it), under the impact even when it struck a roof.
	const FVector Ground(At.X, At.Y, 30.0);
	// The ground surge: a ring of low, wide, long-lived clouds (the wave shape: 24 s) thrown outward
	// from the impact, slowed by the shape's drag: the base surge of a heavy impact.
	if (AVibeCityDirector* Director = [this]() -> AVibeCityDirector* { for (TActorIterator<AVibeCityDirector> It(GetWorld()); It;) return *It; return nullptr; }())
	{
		constexpr int32 RingParcels = 20;
		constexpr double SurgeCmS = 800.0;
		TArray<VlDustParcel, TInlineAllocator<RingParcels>> Ring;
		for (int32 k = 0; k < RingParcels; ++k)
		{
			const double A = 2.0 * PI * k / RingParcels;
			const FVector Out(FMath::Cos(A), FMath::Sin(A), 0.0);
			const FVector P = Ground + Out * Radius * 1.5;
			VlDustParcel D = {};
			D.position[0] = P.X; D.position[1] = P.Y; D.position[2] = P.Z;
			D.velocity[0] = Out.X * SurgeCmS; D.velocity[1] = Out.Y * SurgeCmS; D.velocity[2] = 60.0f;
			D.radius0 = static_cast<float>(Radius);
			D.intensity = 0.8f;
			D.shape = 4; // VL_DUST_WAVE (client-core dust.rs)
			D.palette = 0; // VL_PALETTE_CONCRETE
			D.color_rgba = 0x9d968cff;
			D.seed = 0x9e3779b9u * static_cast<uint32>(LandingCount * RingParcels + k + 1);
			Ring.Add(D);
		}
		Director->EmitDust(Ring);
	}
	// The scorch mark on the ground beneath (at most 16 kept, the oldest replaced).
	if (ScorchBase)
	{
		if (Scorches.Num() >= 16)
		{
			Scorches[0]->DestroyComponent();
			Scorches.RemoveAt(0);
		}
		UDecalComponent* Decal = NewObject<UDecalComponent>(this);
		Decal->SetDecalMaterial(ScorchBase);
		Decal->DecalSize = FVector(Radius * 3.0, Radius * 5.0, Radius * 5.0);
		Decal->SetupAttachment(RootComponent);
		Decal->RegisterComponent();
		Decal->SetWorldLocationAndRotation(Ground, FRotator(-90.0, FMath::FRandRange(0.0, 360.0), 0.0));
		Scorches.Add(Decal);
	}
}

void AVibeDynamicBodies::PlaceMeteor(FFlight& F, const FVector& Pos, const FVector& Velocity)
{
	F.Mesh->SetWorldLocation(Pos);
	F.Mesh->SetVisibility(true);
	F.LastPos = Pos;
	F.LastPosAt = FPlatformTime::Seconds();
	if (!F.Trail || FPlatformTime::Seconds() > F.LaunchedAt + F.Meteor.flight_time_s)
	{
		return;
	}
	const double Speed = Velocity.Size();
	const double Radius = F.Meteor.radius;
	const double Length = Speed * TrailExposureS;
	if (Length < Radius)
	{
		F.Trail->SetVisibility(false); // too slow to streak (or no velocity yet)
		return;
	}
	// A sphere 2r wide and `Length` long, its front at the meteor's centre.
	const FVector Dir = Velocity / Speed;
	F.Trail->SetWorldLocationAndRotation(Pos - Dir * (0.5 * Length), FRotationMatrix::MakeFromZ(Dir).ToQuat());
	F.Trail->SetWorldScale3D(FVector(2.0 * Radius, 2.0 * Radius, Length) / BasicShapeCm);
	F.TrailMaterial->SetVectorParameterValue(TEXT("Head"), FLinearColor(Pos.X, Pos.Y, Pos.Z));
	F.TrailMaterial->SetScalarParameterValue(TEXT("Length"), Length);
	F.Trail->SetVisibility(true);
}
