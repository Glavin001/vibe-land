// Dust puffs from the client core's destruction sources (client-core effects.rs VlDust): soft lit
// billboards that grow, drift and fade. See AVibeCityDirector.

#include "VibeCityDirector.h"

#include "Components/MaterialBillboardComponent.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "vibe_client_core.h"

namespace
{
	// Live puffs at once: the core raises one per destruction source with no budget of its own, and
	// a collapse raises hundreds; the faintest are recycled first.
	constexpr int32 MaxDustPuffs = 96;
	// Peak opacity of a puff's centre.
	constexpr float DustOpacity = 0.55f;
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
		else if (DustSlots.Num() < MaxDustPuffs)
		{
			UMaterialBillboardComponent* Billboard = NewObject<UMaterialBillboardComponent>(this);
			Billboard->SetupAttachment(RootComponent);
			Billboard->SetCastShadow(false);
			Billboard->RegisterComponent();
			UMaterialInstanceDynamic* Material = UMaterialInstanceDynamic::Create(DustMaterial, this);
			Billboard->AddElement(Material, nullptr, false, 100.0f, 100.0f, nullptr);
			Slot = DustSlots.Add(Billboard);
			DustMaterials.Add(Material);
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
		DustMaterials[Slot]->SetVectorParameterValue(TEXT("Color"), ToLinear(D.color_rgba));
		DustSlots[Slot]->SetVisibility(true);
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
			DustSlots[Puff.Slot]->SetVisibility(false);
			FreeDustSlots.Add(Puff.Slot);
			DustPuffs.RemoveAtSwap(p);
			continue;
		}
		// Grows from 30% to full size, fast at first (a puff billows, then hangs).
		const float Size = Puff.Radius * (0.3f + 0.7f * (1.0f - FMath::Square(1.0f - T))) * 2.0f;
		UMaterialBillboardComponent* Billboard = DustSlots[Puff.Slot];
		Billboard->SetWorldLocation(Puff.Origin + Puff.Drift * Puff.Age);
		if (Billboard->Elements.Num() > 0)
		{
			Billboard->Elements[0].BaseSizeX = Size;
			Billboard->Elements[0].BaseSizeY = Size;
			Billboard->MarkRenderStateDirty();
		}
		DustMaterials[Puff.Slot]->SetScalarParameterValue(TEXT("Opacity"), DustOpacity * Fade(T));
	}
}
