// Cosmetic rubble: an Unreal addition on top of the shared destruction (client-side only; the server
// and the web never see it). Where the core reports a break (a fracture, impact or entry dust
// parcel), a handful of small chips in the broken material's colour are thrown out of it, tumble,
// bounce on the ground losing energy, come to rest, lie a while and shrink away. Drawn as one
// instanced mesh (the engine cube, stretched irregularly per chip) in M_VibeCityRubble.

#include "VibeCityDirector.h"
#include "VibeCityCells.h"
#include "VibeNetSubsystem.h"

#include "Components/InstancedStaticMeshComponent.h"
#include "Engine/StaticMesh.h"
#include "Materials/MaterialInterface.h"
#include "vibe_client_core.h"

namespace
{
	constexpr int32 RubbleCapacity = 3000;
	constexpr int32 MaxChipsPerFrame = 200;
	constexpr double GravityCmS2 = 981.0;
	// Broken masonry on paving: a dull bounce (restitution ~0.3) and a skid (60% of the sliding speed
	// kept per bounce); below 30 cm/s on the ground it stops.
	constexpr double Restitution = 0.3;
	constexpr double SlideKept = 0.6;
	constexpr double RestSpeedCmS = 30.0;
	constexpr double LieS = 30.0;
	constexpr double ShrinkS = 3.0;
	const FTransform Hidden(FQuat::Identity, FVector::ZeroVector, FVector::ZeroVector);
}

int32 AVibeCityDirector::LayerNear(const FVector& Position)
{
	if (CellIndexByKey.Num() != CellKeys.Num())
	{
		CellIndexByKey.Reset();
		for (int32 i = 0; i < CellKeys.Num(); ++i)
		{
			CellIndexByKey.Add(CellKeys[i], i);
		}
	}
	const int32* Cell = CellIndexByKey.Find(VibeCityCells::CellKey(Position));
	const UVibeNetSubsystem* NetSubsystem = Net();
	if (!Cell || !NetSubsystem || !CellChunks.IsValidIndex(*Cell))
	{
		return 0;
	}
	int32 Best = INDEX_NONE;
	double BestD = TNumericLimits<double>::Max();
	for (const int32 ChunkIndex : CellChunks[*Cell])
	{
		const double D = FVector::DistSquared(Slots[ChunkIndex].Rest.GetLocation(), Position);
		if (D < BestD)
		{
			BestD = D;
			Best = ChunkIndex;
		}
	}
	const TArrayView<const VlChunkSurface> Surfaces = NetSubsystem->ChunkSurfaces();
	if (!Surfaces.IsValidIndex(Best) || !Catalog.LayerMetal.IsValidIndex(Surfaces[Best].wall))
	{
		return 0;
	}
	return static_cast<int32>(Catalog.LayerMetal[Surfaces[Best].wall].X);
}

int32 AVibeCityDirector::MovingRubble() const
{
	int32 N = 0;
	for (const FChip& C : Chips)
	{
		N += C.bAlive && C.RestSince < 0.0 ? 1 : 0;
	}
	return N;
}

void AVibeCityDirector::SpawnRubble(const VlDustParcel& Source)
{
	// Fracture, impact and entry puffs (the dust shapes 0, 1 and 3): smoulder and waves are not breaks.
	if (Source.shape != 0 && Source.shape != 1 && Source.shape != 3)
	{
		return;
	}
	if (!RubbleInstances)
	{
		RubbleInstances = NewObject<UInstancedStaticMeshComponent>(this, TEXT("Rubble"));
		RubbleInstances->SetStaticMesh(LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube")));
		if (UMaterialInterface* M = LoadObject<UMaterialInterface>(nullptr, TEXT("/Game/VibeCity/Materials/M_VibeCityRubble.M_VibeCityRubble")))
		{
			RubbleInstances->SetMaterial(0, M);
		}
		RubbleInstances->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		RubbleInstances->SetMobility(EComponentMobility::Movable);
		RubbleInstances->NumCustomDataFloats = 5;
		RubbleInstances->SetCastShadow(true);
		RubbleInstances->SetupAttachment(RootComponent);
		RubbleInstances->RegisterComponent();
		Chips.SetNum(RubbleCapacity);
	}
	// More for a stronger break (intensity 0.35..1 -> 6..14 chips), fewer for a puff on impact.
	const int32 Count = FMath::Clamp(FMath::RoundToInt(2.0f + 12.0f * Source.intensity) - (Source.shape == 1 ? 3 : 0), 1, 14);
	// In the broken material's own texture (a little darker: fresh breaks are rougher, in shadow).
	const float Layer = static_cast<float>(LayerNear(FVector(Source.position[0], Source.position[1], Source.position[2])));
	const FLinearColor Color(0.9f, 0.9f, 0.9f);
	for (int32 k = 0; k < Count && RubbleSpawnedThisFrame < MaxChipsPerFrame; ++k, ++RubbleSpawnedThisFrame)
	{
		FChip& C = Chips[ChipHead];
		const int32 Slot = ChipHead;
		ChipHead = (ChipHead + 1) % RubbleCapacity;
		LiveRubbleCount += C.bAlive ? 0 : 1;
		// 4-20 cm across (grit to half a brick), log-uniform: many small, few large; each axis
		// stretched 0.5-1.2.
		const double Size = 4.0 * FMath::Pow(5.0, RubbleRandom.FRand());
		C.Scale = FVector(RubbleRandom.FRandRange(0.5f, 1.2f), RubbleRandom.FRandRange(0.5f, 1.2f), RubbleRandom.FRandRange(0.4f, 1.0f)) * (Size / 100.0);
		C.Half = static_cast<float>(C.Scale.GetMax() * 50.0);
		C.Pos = FVector(Source.position[0], Source.position[1], Source.position[2]) + RubbleRandom.VRand() * Source.radius0 * 0.3;
		// Thrown out and up: spall leaves a break at 2-7 m/s, a landing kicks chips at 1-3 m/s.
		FVector Dir = RubbleRandom.VRand();
		Dir.Z = FMath::Abs(Dir.Z) * 0.8 + 0.2;
		const double Speed = Source.shape == 1 ? RubbleRandom.FRandRange(100.0f, 300.0f) : RubbleRandom.FRandRange(200.0f, 700.0f);
		C.Vel = Dir.GetSafeNormal() * Speed + FVector(Source.velocity[0], Source.velocity[1], Source.velocity[2]);
		C.Rot = FQuat(RubbleRandom.VRand(), RubbleRandom.FRandRange(0.0f, 2.0f * PI));
		C.Spin = RubbleRandom.VRand() * RubbleRandom.FRandRange(2.0f, 14.0f);
		C.RestSince = -1.0;
		C.bAlive = true;
		if (Slot >= RubbleInstances->GetInstanceCount())
		{
			RubbleInstances->AddInstance(Hidden, /*bWorldSpace=*/true);
		}
		RubbleInstances->SetCustomData(Slot, { Color.R, Color.G, Color.B, Layer, RubbleRandom.FRand() }, /*bMarkRenderStateDirty=*/false);
	}
}

void AVibeCityDirector::TickRubble(float DeltaSeconds)
{
	RubbleSpawnedThisFrame = 0;
	if (!RubbleInstances || LiveRubbleCount == 0)
	{
		return;
	}
	const double Dt = FMath::Min<double>(DeltaSeconds, 1.0 / 20.0);
	const double Now = FPlatformTime::Seconds();
	const int32 Count = RubbleInstances->GetInstanceCount();
	for (int32 i = 0; i < Count; ++i)
	{
		FChip& C = Chips[i];
		if (!C.bAlive)
		{
			continue;
		}
		double Shrink = 1.0;
		if (C.RestSince < 0.0)
		{
			C.Vel.Z -= GravityCmS2 * Dt;
			C.Pos += C.Vel * Dt;
			const double SpinRate = C.Spin.Size();
			if (SpinRate > 1e-3)
			{
				C.Rot = FQuat(C.Spin / SpinRate, SpinRate * Dt) * C.Rot;
			}
			// The ground (the city's is the plane at height 0).
			if (C.Pos.Z < C.Half && C.Vel.Z < 0.0)
			{
				C.Pos.Z = C.Half;
				C.Vel.Z = -C.Vel.Z * Restitution;
				C.Vel.X *= SlideKept;
				C.Vel.Y *= SlideKept;
				C.Spin *= 0.5;
				if (C.Vel.Size() < RestSpeedCmS)
				{
					C.Vel = FVector::ZeroVector;
					C.Spin = FVector::ZeroVector;
					C.RestSince = Now;
				}
			}
		}
		else
		{
			const double Lain = Now - C.RestSince;
			if (Lain > LieS + ShrinkS)
			{
				C.bAlive = false;
				--LiveRubbleCount;
				RubbleInstances->UpdateInstanceTransform(i, Hidden, true, false, true);
				continue;
			}
			if (Lain <= LieS)
			{
				continue; // lying still: nothing to update
			}
			Shrink = 1.0 - (Lain - LieS) / ShrinkS;
		}
		RubbleInstances->UpdateInstanceTransform(i, FTransform(C.Rot, C.Pos, C.Scale * Shrink), /*bWorldSpace=*/true, /*bMarkRenderStateDirty=*/false, /*bTeleport=*/true);
	}
	RubbleInstances->MarkRenderStateDirty();
}
