// Dust from the client core's dust policy (client-core dust.rs, the web's city/dustPolicy.ts): the
// parcels each frame brings, kept in a ring of the web's capacity and drawn as the web's curves
// say (vl_dust_eval: growth, rise, drag, the weather's wind), each one instance of a cube stretched
// to its cloud's box, raymarched by M_VibeCityDustVolume as the web's volumetric dust draws it. See
// AVibeCityDirector.

#include "VibeCityDirector.h"

#include "Components/InstancedStaticMeshComponent.h"
#include "Camera/PlayerCameraManager.h"
#include "Components/DecalComponent.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Engine/Engine.h"
#include "Engine/GameViewportClient.h"
#include "Engine/StaticMesh.h"
#include "EngineUtils.h"
#include "GameFramework/PlayerController.h"
#include "VibeCityWeather.h"
#include "Materials/MaterialInterface.h"
#include "VibeLandNet.h"
#include "vibe_client_core.h"

namespace
{
	// dustParcelStore.ts DUST_CAPACITY.
	constexpr int32 DustCapacity = 4096;
	// /Engine/BasicShapes/Cube is 100 cm across: each parcel's box, which the material raymarches.
	constexpr double SphereCm = 100.0;

	// dustParcelStore.ts evalParcel: in over the first 1/6 s, then thinning out to nothing.
	float Fade(float AgeS, float LifeFraction)
	{
		return FMath::Min(1.0f, 6.0f * AgeS) * FMath::Pow(FMath::Max(0.0f, 1.0f - LifeFraction), 1.8f);
	}

	// Which parcels are drawn, as the web's volumetric dust picks them (DustVolumeRenderer.ts
	// select, dustLod.ts): not past the fog's cull distance (where FogExp2 has swallowed 97% of the
	// cloud and of what is behind it: sqrt(-ln 0.03) / density), not under 3 px across, distant ones thinned by spawn serial (one in two
	// beyond 60 m, one in six beyond 140 m, unless the cloud is big for its distance) with the
	// drawn ones carrying the stride's density, and at most the nearest 1024.
	constexpr int32 MaxDrawn = 1024;
	constexpr double MinProjectedPx = 3.0;
	int32 TierStride(double DistanceM, double RadiusM)
	{
		if (DistanceM < 60.0 || DistanceM < RadiusM * 5.0) return 1;
		return DistanceM < 140.0 ? 2 : 6;
	}
}

void AVibeCityDirector::SpawnDust(const VlFrameView& Frame)
{
	if (Frame.dust_count == 0)
	{
		return;
	}
	if (!DustInstances)
	{
		if (!DustVolumeMaterial)
		{
			UE_LOG(LogVibeLand, Warning, TEXT("M_VibeCityDustVolume is missing: VIBE_MATERIALS_ONLY=dustvolume scripts/unreal/import-city-materials.sh. No dust is drawn."));
		}
		DustInstances = NewObject<UInstancedStaticMeshComponent>(this, TEXT("DustParcels"));
		DustInstances->SetStaticMesh(LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube")));
		DustInstances->SetMaterial(0, DustVolumeMaterial);
		DustInstances->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		DustInstances->SetCastShadow(false);
		DustInstances->SetMobility(EComponentMobility::Movable);
		DustInstances->NumCustomDataFloats = 7;
		DustInstances->SetupAttachment(RootComponent);
		DustInstances->RegisterComponent();
		DustParcels.SetNum(DustCapacity);
	}
	for (size_t i = 0; i < Frame.dust_count; ++i)
	{
		// A heavy chunk landing on the ground (an impact puff at ground level from a body of some
		// size) leaves a mark.
		if (Frame.dust[i].shape == 1 /* VL_DUST_IMPACT */ && Frame.dust[i].position[2] < 150.0f && Frame.dust[i].radius0 > 40.0f)
		{
			MarkGround(Frame.dust[i]);
		}
		FDustParcel& Slot = DustParcels[DustHead];
		LiveDustCount += Slot.bAlive ? 0 : 1;
		Slot.P = Frame.dust[i];
		Slot.Age = Frame.dust[i].age_s;
		Slot.bAlive = true;
		Slot.Serial = DustSerial++;
		if (DustHead >= DustInstances->GetInstanceCount())
		{
			DustInstances->AddInstance(FTransform(FQuat::Identity, FVector::ZeroVector, FVector::ZeroVector), /*bWorldSpace=*/true);
		}
		DustHead = (DustHead + 1) % DustCapacity;
	}
}

void AVibeCityDirector::TickDust(float DeltaSeconds)
{
	if (!DustInstances || LiveDustCount == 0)
	{
		return;
	}
	// The web's default wind (fogSettings.ts): 8 m/s toward compass 45°, server space.
	float Wind[3];
	vl_weather_wind(8.0f, 45.0f, Wind);
	// The camera, for the selection: pixels per metre at 1 m from the vertical field of view.
	FVector Eye = FVector::ZeroVector, Forward = FVector::ForwardVector;
	double PxPerM = 1080.0 / (2.0 * FMath::Tan(FMath::DegreesToRadians(45.0)));
	double CosCull = -1.0, HalfDiagRad = PI;
	if (const APlayerController* PC = GetWorld() ? GetWorld()->GetFirstPlayerController() : nullptr; PC && PC->PlayerCameraManager)
	{
		Eye = PC->PlayerCameraManager->GetCameraLocation();
		Forward = PC->PlayerCameraManager->GetCameraRotation().Vector();
		FVector2D Viewport(1920.0, 1080.0);
		if (GEngine && GEngine->GameViewport)
		{
			GEngine->GameViewport->GetViewportSize(Viewport);
		}
		const double TanH = FMath::Tan(FMath::DegreesToRadians(PC->PlayerCameraManager->GetFOVAngle() * 0.5));
		const double TanV = TanH * Viewport.Y / FMath::Max(Viewport.X, 1.0);
		PxPerM = Viewport.Y / (2.0 * TanV);
		HalfDiagRad = FMath::Atan(FMath::Sqrt(TanH * TanH + TanV * TanV));
	}

	// dustLod.ts fogCullDistance, from the weather's fog (none without it).
	double CullM = TNumericLimits<double>::Max();
	if (TActorIterator<AVibeCityWeather> It(GetWorld()); It && It->FogExp2Density() > 0.0f)
	{
		CullM = FMath::Sqrt(-FMath::Loge(0.03)) / It->FogExp2Density();
	}

	struct FPick
	{
		int32 Slot;
		double DistanceM;
		int32 Stride;
		VlDustEval E;
	};
	TArray<FPick, TInlineAllocator<256>> Picks;
	const int32 Count = DustInstances->GetInstanceCount();
	const FTransform Hidden(FQuat::Identity, FVector::ZeroVector, FVector::ZeroVector);
	for (int32 i = 0; i < Count; ++i)
	{
		FDustParcel& D = DustParcels[i];
		if (!D.bAlive)
		{
			continue;
		}
		D.Age += DeltaSeconds;
		VlDustEval E = {};
		if (vl_dust_eval(&D.P, D.Age, Wind[0], Wind[1], Wind[2], 1 /* Unreal space */, &E) != 1)
		{
			D.bAlive = false;
			--LiveDustCount;
			DustInstances->UpdateInstanceTransform(i, Hidden, true, false, true);
			continue;
		}
		const FVector Centre(E.centre[0], E.centre[1], E.centre[2]);
		const double DistanceM = FVector::Dist(Centre, Eye) / 100.0;
		const double RadiusM = E.radius / 100.0;
		// In view (a sphere against the view cone, as the web tests its frustum), big enough, and kept
		// by its tier.
		const FVector To = Centre - Eye;
		const bool bInView = DistanceM <= RadiusM
			|| FMath::Acos(FMath::Clamp(FVector::DotProduct(To.GetSafeNormal(), Forward), -1.0, 1.0)) <= HalfDiagRad + FMath::Asin(FMath::Min(1.0, RadiusM * 0.87 / DistanceM));
		const double ProjectedPx = (E.size[0] / 100.0) * PxPerM / FMath::Max(DistanceM, 1.0);
		const int32 Stride = TierStride(DistanceM, RadiusM);
		if (DistanceM - RadiusM > CullM || !bInView || ProjectedPx < MinProjectedPx || D.Serial % Stride != 0)
		{
			DustInstances->UpdateInstanceTransform(i, Hidden, true, false, true);
			continue;
		}
		Picks.Add({ i, DistanceM, Stride, E });
	}
	if (Picks.Num() > MaxDrawn)
	{
		Picks.Sort([](const FPick& A, const FPick& B) { return A.DistanceM < B.DistanceM; });
		for (int32 k = MaxDrawn; k < Picks.Num(); ++k)
		{
			DustInstances->UpdateInstanceTransform(Picks[k].Slot, Hidden, true, false, true);
		}
		Picks.SetNum(MaxDrawn);
	}
	DrawnDustCount = Picks.Num();
	for (const FPick& Pick : Picks)
	{
		const FDustParcel& D = DustParcels[Pick.Slot];
		const VlDustEval& E = Pick.E;
		const FVector Size(E.size[0], E.size[1], E.size[2]);
		DustInstances->UpdateInstanceTransform(Pick.Slot, FTransform(FQuat::Identity, FVector(E.centre[0], E.centre[1], E.centre[2]), Size / SphereCm),
			/*bWorldSpace=*/true, /*bMarkRenderStateDirty=*/false, /*bTeleport=*/true);
		const FLinearColor Color(FColor((D.P.color_rgba >> 24) & 0xFF, (D.P.color_rgba >> 16) & 0xFF, (D.P.color_rgba >> 8) & 0xFF, 0xFF));
		// The material raymarches the parcel as the web's volumetric dust does (DustVolumeRenderer.ts
		// write: density = e.density x the LOD stride, and the fade); its noise eats E.erosion of the
		// cloud; the seed varies it per parcel.
		const float Density = D.P.intensity * E.density * Pick.Stride;
		DustInstances->SetCustomData(Pick.Slot, { Color.R, Color.G, Color.B, Density, E.erosion, static_cast<float>(D.P.seed % 9973) / 9973.0f, Fade(E.age_s, E.life_fraction) },
			/*bMarkRenderStateDirty=*/false);
	}
	DustInstances->MarkRenderStateDirty();
}

void AVibeCityDirector::MarkGround(const VlDustParcel& Impact)
{
	if (!DustMarkMaterial)
	{
		UMaterialInterface* Base = LoadObject<UMaterialInterface>(nullptr, TEXT("/Game/VibeCity/Materials/M_VibeCityScorch.M_VibeCityScorch"));
		if (!Base)
		{
			return;
		}
		DustMarkMaterial = UMaterialInstanceDynamic::Create(Base, this);
		// Settled dust: an earth tone a little lighter than asphalt, at under half strength, so the
		// street shows through (full strength in pale grey read as white paint).
		DustMarkMaterial->SetVectorParameterValue(TEXT("Color"), FLinearColor(0.26f, 0.24f, 0.21f));
		DustMarkMaterial->SetScalarParameterValue(TEXT("Fade"), 0.45f);
	}
	constexpr int32 MaxMarks = 64;
	if (DustMarkDecals.Num() >= MaxMarks)
	{
		DustMarkDecals[0]->DestroyComponent();
		DustMarkDecals.RemoveAt(0);
	}
	UDecalComponent* Decal = NewObject<UDecalComponent>(this);
	Decal->SetDecalMaterial(DustMarkMaterial);
	const double Size = Impact.radius0 * 3.0;
	Decal->DecalSize = FVector(Size, Size, Size);
	Decal->SetupAttachment(RootComponent);
	Decal->RegisterComponent();
	Decal->SetWorldLocationAndRotation(FVector(Impact.position[0], Impact.position[1], 0.0), FRotator(-90.0, (Impact.seed % 360), 0.0));
	DustMarkDecals.Add(Decal);
	++DustMarkCount;
}

void AVibeCityDirector::EmitTrails(const VlFrameView& Frame)
{
	// Debris falling or thrown sheds dust as it goes: a puff where it was, while it moves faster than
	// a brisk fall (4 m/s, about 0.8 m of free fall), every 0.12 s, small and short-lived (the entry
	// shape: 5 s), at most 24 a frame. An Unreal addition to the shared dust, in its parcels.
	constexpr double TrailSpeedCmS = 400.0;
	constexpr double TrailEveryS = 0.12;
	constexpr int32 MaxPuffsPerFrame = 24;
	const double Now = FPlatformTime::Seconds();
	TArray<VlDustParcel, TInlineAllocator<MaxPuffsPerFrame>> Puffs;
	for (size_t i = 0; i < Frame.body_pose_count; ++i)
	{
		const VlBodyPose& P = Frame.body_poses[i];
		const uint64 Key = (static_cast<uint64>(P.structure) << 32) | P.body;
		const FVector Pos(P.pos[0], P.pos[1], P.pos[2]);
		FTrail& T = Trails.FindOrAdd(Key);
		const double Dt = Now - T.At;
		if (T.At > 0.0 && Dt > 0.0 && Dt < 0.5 && Puffs.Num() < MaxPuffsPerFrame
			&& FVector::Dist(Pos, T.Pos) / Dt > TrailSpeedCmS && Now - T.LastPuff >= TrailEveryS)
		{
			VlDustParcel D = {};
			D.position[0] = T.Pos.X; D.position[1] = T.Pos.Y; D.position[2] = T.Pos.Z;
			D.radius0 = 30.0f;
			D.intensity = 0.35f;
			D.shape = 3; // VL_DUST_ENTRY (client-core dust.rs)
			D.palette = 0; // VL_PALETTE_CONCRETE
			D.color_rgba = 0xa8a39bff;
			D.seed = static_cast<uint32>(Key * 2654435761u) ^ static_cast<uint32>(TrailPuffCount);
			Puffs.Add(D);
			T.LastPuff = Now;
			++TrailPuffCount;
		}
		T.Pos = Pos;
		T.At = Now;
	}
	if (Puffs.Num() > 0)
	{
		EmitDust(Puffs);
	}
	// Forget bodies not seen for 2 s.
	for (auto It = Trails.CreateIterator(); It; ++It)
	{
		if (Now - It.Value().At > 2.0)
		{
			It.RemoveCurrent();
		}
	}
}

int32 AVibeCityDirector::InjectDustForTest(TArrayView<const VlDustParcel> Parcels)
{
	const int32 First = DustHead;
	VlFrameView Frame = {};
	Frame.dust = Parcels.GetData();
	Frame.dust_count = static_cast<size_t>(Parcels.Num());
	SpawnDust(Frame);
	return First;
}

TOptional<FBox> AVibeCityDirector::DustBox(int32 Slot) const
{
	if (!DustInstances || !DustParcels.IsValidIndex(Slot) || !DustParcels[Slot].bAlive || Slot >= DustInstances->GetInstanceCount())
	{
		return {};
	}
	FTransform T;
	DustInstances->GetInstanceTransform(Slot, T, /*bWorldSpace=*/true);
	const FVector Half = T.GetScale3D() * 50.0; // the 100 cm sphere
	return FBox(T.GetLocation() - Half, T.GetLocation() + Half);
}
