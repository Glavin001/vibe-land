#include "VibeCityHUD.h"

#include "CanvasItem.h"
#include "Engine/Canvas.h"
#include "Engine/Engine.h"
#include "Engine/Font.h"
#include "Engine/GameInstance.h"
#include "Engine/World.h"
#include "GameFramework/PlayerController.h"
#include "VibeNetSubsystem.h"
#include "VibePlayerPawn.h"

namespace
{
	// ui/EnergyBar.tsx and ui/LowEnergyWarning.tsx.
	constexpr float HpMax = 100.0f;
	constexpr float EnergyBarNominalMax = 2000.0f;
	constexpr float LowEnergyThreshold = 250.0f;
	// DamageOverlay: a red flash that fades.
	constexpr float DamageFlashS = 0.4f;
}

void AVibeCityHUD::BeginPlay()
{
	Super::BeginPlay();
	const UGameInstance* GameInstance = GetGameInstance();
	if (UVibeNetSubsystem* Net = GameInstance ? GameInstance->GetSubsystem<UVibeNetSubsystem>() : nullptr)
	{
		FrameHandle = Net->OnFrame.AddUObject(this, &AVibeCityHUD::OnFrame);
	}
}

void AVibeCityHUD::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
	const UGameInstance* GameInstance = GetGameInstance();
	if (UVibeNetSubsystem* Net = GameInstance ? GameInstance->GetSubsystem<UVibeNetSubsystem>() : nullptr)
	{
		Net->OnFrame.Remove(FrameHandle);
	}
	Super::EndPlay(EndPlayReason);
}

void AVibeCityHUD::OnFrame(const VlFrameView& Frame)
{
	Local = Frame.local;
	for (size_t i = 0; i < Frame.event_count; ++i)
	{
		if (Frame.events[i].kind == VL_EVENT_DAMAGE)
		{
			DamageFlash = DamageFlashS;
		}
	}
}

void AVibeCityHUD::Bar(float X, float Y, float W, float H, float Fraction, const FLinearColor& Color, const FString& Label)
{
	DrawRect(FLinearColor(0.0f, 0.0f, 0.0f, 0.55f), X, Y, W, H);
	DrawRect(Color, X + 2.0f, Y + 2.0f, (W - 4.0f) * FMath::Clamp(Fraction, 0.0f, 1.0f), H - 4.0f);
	float TextW = 0.0f, TextH = 0.0f;
	UFont* Font = GEngine->GetSmallFont();
	GetTextSize(Label, TextW, TextH, Font);
	DrawText(Label, FLinearColor::White, X + 8.0f, Y + (H - TextH) * 0.5f, Font);
}

void AVibeCityHUD::DrawHUD()
{
	Super::DrawHUD();
	if (!Canvas)
	{
		return;
	}
	const double Now = GetWorld()->GetRealTimeSeconds();
	const float Dt = LastDrawTime > 0.0 ? static_cast<float>(Now - LastDrawTime) : 0.0f;
	LastDrawTime = Now;
	DamageFlash = FMath::Max(0.0f, DamageFlash - Dt);

	const float W = Canvas->ClipX;
	const float H = Canvas->ClipY;
	const float Scale = H / 1080.0f;
	const VlPlayer& Me = Local.player;
	const bool bValid = (Me.flags & VL_PLAYER_VALID) != 0;
	const bool bDead = bValid && (Me.state_flags & VL_STATE_DEAD);

	if (DamageFlash > 0.0f)
	{
		DrawRect(FLinearColor(0.8f, 0.0f, 0.0f, 0.35f * DamageFlash / DamageFlashS), 0.0f, 0.0f, W, H);
	}

	// Crosshair.
	if (bValid && !bDead)
	{
		const float Cx = W * 0.5f, Cy = H * 0.5f, Arm = 9.0f * Scale, Gap = 4.0f * Scale;
		const FLinearColor C(1.0f, 1.0f, 1.0f, 0.9f);
		DrawLine(Cx - Gap - Arm, Cy, Cx - Gap, Cy, C, 2.0f);
		DrawLine(Cx + Gap, Cy, Cx + Gap + Arm, Cy, C, 2.0f);
		DrawLine(Cx, Cy - Gap - Arm, Cx, Cy - Gap, C, 2.0f);
		DrawLine(Cx, Cy + Gap, Cx, Cy + Gap + Arm, C, 2.0f);
	}

	if (!bValid)
	{
		return;
	}

	// Health and energy, bottom left.
	const float BarW = 320.0f * Scale, BarH = 26.0f * Scale, Left = 32.0f * Scale;
	const float Hp = static_cast<float>(Me.hp);
	Bar(Left, H - 2.0f * BarH - 40.0f * Scale, BarW, BarH, Hp / HpMax, FLinearColor(0.85f, 0.2f, 0.2f, 0.9f),
		FString::Printf(TEXT("HP %d / %d"), FMath::FloorToInt(Hp), static_cast<int32>(HpMax)));
	if (Local.energy >= 0.0f)
	{
		const FString Energy = Local.energy >= EnergyBarNominalMax ? FString::Printf(TEXT("Energy %d+"), FMath::FloorToInt(Local.energy))
			: FString::Printf(TEXT("Energy %d"), FMath::FloorToInt(Local.energy));
		Bar(Left, H - BarH - 32.0f * Scale, BarW, BarH, Local.energy / EnergyBarNominalMax, FLinearColor(0.2f, 0.75f, 1.0f, 0.9f), Energy);
	}

	// Weapon, bottom right.
	if (const AVibePlayerPawn* Pawn = Cast<AVibePlayerPawn>(GetOwningPawn()))
	{
		const FString Weapon = FString::Printf(TEXT("%s   [1] Rifle  [2] Cannon  [3] Meteor"), AVibePlayerPawn::WeaponName(Pawn->Weapon()));
		float TextW = 0.0f, TextH = 0.0f;
		GetTextSize(Weapon, TextW, TextH, GEngine->GetMediumFont());
		DrawText(Weapon, FLinearColor::White, W - TextW - Left, H - TextH - 32.0f * Scale, GEngine->GetMediumFont());
	}

	// States, centred.
	auto Banner = [&](const FString& Text, const FLinearColor& Color, float Y)
	{
		float TextW = 0.0f, TextH = 0.0f;
		GetTextSize(Text, TextW, TextH, GEngine->GetLargeFont());
		DrawText(Text, Color, (W - TextW) * 0.5f, Y, GEngine->GetLargeFont());
	};
	if (bDead)
	{
		Banner(TEXT("You died - respawning"), FLinearColor(1.0f, 0.35f, 0.3f), H * 0.4f);
	}
	else if (Me.state_flags & VL_STATE_SPAWN_PROTECTED)
	{
		Banner(TEXT("Spawn protection"), FLinearColor(0.6f, 0.9f, 1.0f), H * 0.62f);
	}
	// Car hints (the web's ControlHintsOverlay).
	if (const AVibePlayerPawn* Pawn = Cast<AVibePlayerPawn>(GetOwningPawn()); Pawn && !bDead)
	{
		FString Hint;
		if (Pawn->IsInVehicle())
		{
			Hint = TEXT("W/S throttle  A/D steer  Space handbrake  R reset car  E leave");
		}
		else if (Pawn->NearCar())
		{
			Hint = TEXT("E  drive");
		}
		if (!Hint.IsEmpty())
		{
			float TextW = 0.0f, TextH = 0.0f;
			GetTextSize(Hint, TextW, TextH, GEngine->GetMediumFont());
			DrawText(Hint, FLinearColor::White, (W - TextW) * 0.5f, H * 0.75f, GEngine->GetMediumFont());
		}
	}
	if (Local.energy >= 0.0f && Local.energy > 0.0f && Local.energy < LowEnergyThreshold)
	{
		Banner(TEXT("Low energy"), FLinearColor(1.0f, 0.8f, 0.2f), H * 0.68f);
	}
}
