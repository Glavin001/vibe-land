// Dust from the client core's dust policy (client-core dust.rs, the web's city/dustPolicy.ts): the
// parcels each frame brings, kept in a ring of the web's capacity and drawn as the web's curves
// say (vl_dust_eval: growth, rise, drag, the weather's wind), each one instance of a sphere
// stretched to its cloud's box in M_VibeCityDustVolume. See AVibeCityDirector.

#include "VibeCityDirector.h"

#include "Components/InstancedStaticMeshComponent.h"
#include "Engine/StaticMesh.h"
#include "Materials/MaterialInterface.h"
#include "VibeLandNet.h"
#include "vibe_client_core.h"

namespace
{
	// dustParcelStore.ts DUST_CAPACITY.
	constexpr int32 DustCapacity = 4096;
	// /Engine/BasicShapes/Sphere is 100 cm across.
	constexpr double SphereCm = 100.0;

	float Fade(float LifeFraction)
	{
		// In over the first 5% of its life, then thinning out to nothing.
		return LifeFraction < 0.05f ? LifeFraction / 0.05f : FMath::Pow(1.0f - LifeFraction, 1.5f);
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
		DustInstances->SetStaticMesh(LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Sphere.Sphere")));
		DustInstances->SetMaterial(0, DustVolumeMaterial);
		DustInstances->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		DustInstances->SetCastShadow(false);
		DustInstances->SetMobility(EComponentMobility::Movable);
		DustInstances->NumCustomDataFloats = 6;
		DustInstances->SetupAttachment(RootComponent);
		DustInstances->RegisterComponent();
		DustParcels.SetNum(DustCapacity);
	}
	for (size_t i = 0; i < Frame.dust_count; ++i)
	{
		FDustParcel& Slot = DustParcels[DustHead];
		LiveDustCount += Slot.bAlive ? 0 : 1;
		Slot.P = Frame.dust[i];
		Slot.Age = Frame.dust[i].age_s;
		Slot.bAlive = true;
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
	const int32 Count = DustInstances->GetInstanceCount();
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
			DustInstances->UpdateInstanceTransform(i, FTransform(FQuat::Identity, FVector::ZeroVector, FVector::ZeroVector), true, false, true);
			continue;
		}
		const FVector Size(E.size[0], E.size[1], E.size[2]);
		DustInstances->UpdateInstanceTransform(i, FTransform(FQuat::Identity, FVector(E.centre[0], E.centre[1], E.centre[2]), Size / SphereCm),
			/*bWorldSpace=*/true, /*bMarkRenderStateDirty=*/false, /*bTeleport=*/true);
		const FLinearColor Color(FColor((D.P.color_rgba >> 24) & 0xFF, (D.P.color_rgba >> 16) & 0xFF, (D.P.color_rgba >> 8) & 0xFF, 0xFF));
		const float Opacity = FMath::Clamp(D.P.intensity * E.density * 0.35f * Fade(E.life_fraction), 0.0f, 1.0f);
		// The material's noise eats E.erosion of the cloud; the seed varies it per parcel.
		DustInstances->SetCustomData(i, { Color.R, Color.G, Color.B, Opacity, E.erosion, static_cast<float>(D.P.seed % 9973) / 9973.0f },
			/*bMarkRenderStateDirty=*/false);
	}
	DustInstances->MarkRenderStateDirty();
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
