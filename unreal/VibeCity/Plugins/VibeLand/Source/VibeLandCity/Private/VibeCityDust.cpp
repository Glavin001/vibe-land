// Dust from the client core's destruction sources (client-core effects.rs VlDust): each puff a
// cluster of soft sprites (M_VibeCityDust: lit as a volume, depth-faded) at different offsets and
// sizes, so a cloud has depth and parallax, as particle dust does. See AVibeCityDirector.

#include "VibeCityDirector.h"

#include "Components/MaterialBillboardComponent.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "vibe_client_core.h"

namespace
{
	// Live puffs at once (the core sets no dust budget; a collapse raises hundreds): the faintest
	// are recycled.
	constexpr int32 MaxDustPuffs = 64;
	constexpr int32 SpritesPerPuff = 4;
	// Peak opacity of a sprite's centre (four overlap toward the cloud's core).
	constexpr float DustOpacity = 0.4f;
	// Upward drift of warm dust, cm/s, and outward drift along the broken face.
	constexpr float DustRiseCmPerS = 40.0f;
	constexpr float DustOutCmPerS = 60.0f;

	FLinearColor ToLinear(uint32 Rgba)
	{
		return FLinearColor(FColor((Rgba >> 24) & 0xFF, (Rgba >> 16) & 0xFF, (Rgba >> 8) & 0xFF, 0xFF));
	}

	float Fade(float T)
	{
		// In over the first 10%, out over the rest (ease-out).
		return T < 0.1f ? T / 0.1f : FMath::Square(1.0f - (T - 0.1f) / 0.9f);
	}
}

void AVibeCityDirector::SpawnDust(const VlFrameView& Frame)
{
	if (!DustMaterial || Frame.dust_count == 0)
	{
		return;
	}
	for (size_t i = 0; i < Frame.dust_count; ++i)
	{
		const VlDust& D = Frame.dust[i];
		int32 Slot = INDEX_NONE;
		if (FreeDustSlots.Num() > 0)
		{
			Slot = FreeDustSlots.Pop();
		}
		else if (DustSlotCount < MaxDustPuffs)
		{
			Slot = DustSlotCount++;
			for (int32 k = 0; k < SpritesPerPuff; ++k)
			{
				UMaterialBillboardComponent* Sprite = NewObject<UMaterialBillboardComponent>(this);
				Sprite->SetupAttachment(RootComponent);
				Sprite->SetCastShadow(false);
				Sprite->RegisterComponent();
				UMaterialInstanceDynamic* Material = UMaterialInstanceDynamic::Create(DustMaterial, this);
				Sprite->AddElement(Material, nullptr, false, 100.0f, 100.0f, nullptr);
				DustSprites.Add(Sprite);
				DustMaterials.Add(Material);
			}
		}
		else
		{
			// Recycle the faintest live puff.
			int32 Faintest = INDEX_NONE;
			float Least = TNumericLimits<float>::Max();
			for (int32 p = 0; p < DustPuffs.Num(); ++p)
			{
				const float Level = Fade(DustPuffs[p].Age / DustPuffs[p].Lifetime) * DustPuffs[p].Radius;
				if (Level < Least)
				{
					Least = Level;
					Faintest = p;
				}
			}
			if (Faintest == INDEX_NONE)
			{
				continue;
			}
			Slot = DustPuffs[Faintest].Slot;
			DustPuffs.RemoveAtSwap(Faintest);
		}
		const FVector Normal(D.normal[0], D.normal[1], D.normal[2]);
		FDustPuff& Puff = DustPuffs.AddDefaulted_GetRef();
		Puff.Origin = FVector(D.position[0], D.position[1], D.position[2]);
		Puff.Drift = Normal * DustOutCmPerS + FVector::UpVector * DustRiseCmPerS;
		Puff.Radius = D.radius;
		Puff.Lifetime = FMath::Max(0.2f, D.lifetime_s);
		Puff.Slot = Slot;
		// A stable cluster per puff: sprites spread through the cloud, larger toward its centre.
		FRandomStream Random(static_cast<int32>(Puff.Origin.X * 7.0 + Puff.Origin.Y * 13.0 + Puff.Origin.Z * 17.0));
		for (int32 k = 0; k < SpritesPerPuff; ++k)
		{
			Puff.Offsets[k] = k == 0 ? FVector::ZeroVector : Random.GetUnitVector() * Random.FRandRange(0.3f, 0.6f) + FVector::UpVector * 0.2f;
			Puff.Sizes[k] = k == 0 ? 1.0f : Random.FRandRange(0.55f, 0.85f);
			DustMaterials[Slot * SpritesPerPuff + k]->SetVectorParameterValue(TEXT("Color"), ToLinear(D.color_rgba));
			DustSprites[Slot * SpritesPerPuff + k]->SetVisibility(true);
		}
	}
}

void AVibeCityDirector::TickDust(float DeltaSeconds)
{
	for (int32 p = DustPuffs.Num() - 1; p >= 0; --p)
	{
		FDustPuff& Puff = DustPuffs[p];
		Puff.Age += DeltaSeconds;
		const float T = Puff.Age / Puff.Lifetime;
		if (T >= 1.0f)
		{
			for (int32 k = 0; k < SpritesPerPuff; ++k)
			{
				DustSprites[Puff.Slot * SpritesPerPuff + k]->SetVisibility(false);
			}
			FreeDustSlots.Add(Puff.Slot);
			DustPuffs.RemoveAtSwap(p);
			continue;
		}
		// Grows from 30% to full size, fast at first (a puff billows, then hangs); the cluster
		// spreads as it grows.
		const float Radius = Puff.Radius * (0.3f + 0.7f * (1.0f - FMath::Square(1.0f - T)));
		const FVector Centre = Puff.Origin + Puff.Drift * Puff.Age;
		for (int32 k = 0; k < SpritesPerPuff; ++k)
		{
			UMaterialBillboardComponent* Sprite = DustSprites[Puff.Slot * SpritesPerPuff + k];
			Sprite->SetWorldLocation(Centre + Puff.Offsets[k] * Radius);
			if (Sprite->Elements.Num() > 0)
			{
				const float Size = Radius * 2.0f * Puff.Sizes[k];
				Sprite->Elements[0].BaseSizeX = Size;
				Sprite->Elements[0].BaseSizeY = Size;
				Sprite->MarkRenderStateDirty();
			}
			DustMaterials[Puff.Slot * SpritesPerPuff + k]->SetScalarParameterValue(TEXT("Opacity"), DustOpacity * Fade(T));
		}
	}
}
