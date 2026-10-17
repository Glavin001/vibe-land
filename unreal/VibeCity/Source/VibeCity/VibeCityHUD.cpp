#include "VibeCityHUD.h"
#include "VibeSettings.h"

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
	// ui/useDamageFeedback.ts.
	constexpr double DamageDurationS = 1.2;
	constexpr float PeakDamageRef = 35.0f;
	constexpr float PeakAlphaCap = 0.75f;
	constexpr float VignetteGain = 0.7f;
	constexpr float DeathHoldPeak = 0.6f;
	constexpr float DirectionLobePow = 1.5f;
	// shared/src/constants.rs.
	constexpr float SpawnProtectionS = 3.0f;
	constexpr float MeleeCooldownS = 0.9f;
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
	const double Now = GetWorld()->GetRealTimeSeconds();
	for (size_t i = 0; i < Frame.event_count; ++i)
	{
		const VlEvent& E = Frame.events[i];
		if (E.kind != VL_EVENT_DAMAGE)
		{
			continue;
		}
		// computeBodyLocalDirectionWeights: the attacker in the view's frame, lobes cos^1.5.
		FDamage D;
		D.Started = Now;
		D.Peak = FMath::Min(1.0f, FMath::Pow(static_cast<float>(E.a) / PeakDamageRef, 0.85f)) * PeakAlphaCap;
		FVector To = FVector(E.p0[0], E.p0[1], E.p0[2]) - FVector(Local.player.pos[0], Local.player.pos[1], Local.player.pos[2]);
		To.Z = 0.0;
		const APlayerController* PC = GetOwningPlayerController();
		const float Yaw = PC ? PC->GetControlRotation().Yaw : 0.0f;
		if (To.SizeSquared() < 1.0)
		{
			D.Front = 1.0f;
		}
		else
		{
			const FVector Fwd = FRotator(0.0, Yaw, 0.0).Vector();
			const FVector Right = FVector::CrossProduct(FVector::UpVector, Fwd);
			const float Angle = FMath::Atan2(static_cast<float>(FVector::DotProduct(To, Right)), static_cast<float>(FVector::DotProduct(To, Fwd)));
			auto Lobe = [](float V) { return FMath::Pow(FMath::Max(0.0f, V - 1e-6f), DirectionLobePow); };
			D.Front = Lobe(FMath::Cos(Angle));
			D.Back = Lobe(-FMath::Cos(Angle));
			D.Right = Lobe(FMath::Sin(Angle));
			D.Left = Lobe(-FMath::Sin(Angle));
		}
		Damage.Add(D);
	}
	// A city reset rebootstraps the stream (anyone's R, or the web's RESET CITY).
	if (Bootstraps > 0 && Frame.stats.bootstraps > Bootstraps)
	{
		ResetNoteUntil = Now + 2.5;
	}
	Bootstraps = Frame.stats.bootstraps;
}

void AVibeCityHUD::DrawEdges(float W, float H, float Front, float Back, float Left, float Right, float Vignette)
{
	// DamageOverlay's gradients from each edge (55% reach) and its vignette, as bands fading inward.
	constexpr int32 Bands = 14;
	const float Step = 1.0f / Bands;
	for (int32 b = 0; b < Bands; ++b)
	{
		const float T = b * Step;
		const float Fade = (1.0f - T) * Step * 2.2f;
		auto Band = [&](float Alpha, float X, float Y, float BW, float BH) {
			if (Alpha * Fade > 0.002f)
			{
				DrawRect(FLinearColor(0.86f, 0.12f, 0.12f, Alpha * Fade), X, Y, BW, BH);
			}
		};
		const float Reach = 0.55f;
		Band(Front, 0.0f, H * T * Reach, W, H * Step * Reach);
		Band(Back, 0.0f, H - H * (T + Step) * Reach, W, H * Step * Reach);
		Band(Left, W * T * Reach, 0.0f, W * Step * Reach, H);
		Band(Right, W - W * (T + Step) * Reach, 0.0f, W * Step * Reach, H);
		const float VReach = 0.32f;
		Band(Vignette, 0.0f, H * T * VReach, W, H * Step * VReach);
		Band(Vignette, 0.0f, H - H * (T + Step) * VReach, W, H * Step * VReach);
		Band(Vignette, W * T * VReach, 0.0f, W * Step * VReach, H);
		Band(Vignette, W - W * (T + Step) * VReach, 0.0f, W * Step * VReach, H);
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

	const float W = Canvas->ClipX;
	const float H = Canvas->ClipY;
	const float Scale = H / 1080.0f;
	const VlPlayer& Me = Local.player;
	const bool bValid = (Me.flags & VL_PLAYER_VALID) != 0;
	const bool bDead = bValid && (Me.state_flags & VL_STATE_DEAD);

	// Damage from where it came, fading over 1.2 s (easeOutQuad), and the vignette; held while dead.
	{
		float Front = 0.0f, Back = 0.0f, LeftL = 0.0f, RightL = 0.0f;
		for (int32 i = Damage.Num() - 1; i >= 0; --i)
		{
			const float T = static_cast<float>((Now - Damage[i].Started) / DamageDurationS);
			if (T >= 1.0f)
			{
				Damage.RemoveAtSwap(i);
				continue;
			}
			const float P = Damage[i].Peak * (1.0f - FMath::Square(T));
			Front += Damage[i].Front * P;
			Back += Damage[i].Back * P;
			LeftL += Damage[i].Left * P;
			RightL += Damage[i].Right * P;
		}
		const float Vignette = FMath::Max(FMath::Min(1.0f, (Front + Back + LeftL + RightL) * VignetteGain), bDead ? DeathHoldPeak * 0.85f : 0.0f);
		DrawEdges(W, H, FMath::Min(Front, 1.0f), FMath::Min(Back, 1.0f), FMath::Min(LeftL, 1.0f), FMath::Min(RightL, 1.0f), Vignette);
	}

	const AVibePlayerPawn* Flyer = Cast<AVibePlayerPawn>(GetOwningPawn());
	// The aerial camera (and a drop on its way) draws no crosshair or weapon (GameWorld.tsx hides the
	// player's HUD while flying) and shows the web's flight panel (CityFlightControls.tsx).
	const bool bFlying = Flyer && (Flyer->IsAerial() || Flyer->IsDropPending());

	// The scope (App.tsx): darkening toward the edges and a fine reticle while aiming, eased in.
	ScopeBlend = FMath::FInterpTo(ScopeBlend, Flyer && Flyer->IsAiming() && !bDead ? 1.0f : 0.0f, Dt, 12.0f);
	if (ScopeBlend > 0.01f)
	{
		constexpr int32 Rings = 12;
		const float R0 = H * 0.42f;
		for (int32 r = 0; r < Rings; ++r)
		{
			const float Inner = R0 * (1.0f + static_cast<float>(r) / Rings * 0.9f);
			const FLinearColor Shade(0.0f, 0.0f, 0.0f, ScopeBlend * 0.07f);
			DrawRect(Shade, 0.0f, 0.0f, W, FMath::Max(0.0f, H * 0.5f - Inner));
			DrawRect(Shade, 0.0f, H * 0.5f + Inner, W, FMath::Max(0.0f, H * 0.5f - Inner));
			DrawRect(Shade, 0.0f, 0.0f, FMath::Max(0.0f, W * 0.5f - Inner), H);
			DrawRect(Shade, W * 0.5f + Inner, 0.0f, FMath::Max(0.0f, W * 0.5f - Inner), H);
		}
		const FLinearColor Reticle(0.05f, 0.05f, 0.05f, 0.7f * ScopeBlend);
		DrawLine(W * 0.5f - R0, H * 0.5f, W * 0.5f - 18.0f * Scale, H * 0.5f, Reticle, 1.5f);
		DrawLine(W * 0.5f + 18.0f * Scale, H * 0.5f, W * 0.5f + R0, H * 0.5f, Reticle, 1.5f);
		DrawLine(W * 0.5f, H * 0.5f + 18.0f * Scale, W * 0.5f, H * 0.5f + R0, Reticle, 1.5f);
	}

	// Crosshair: red over a player the shot would hit (brighter on the head).
	bDrewCrosshair = bValid && !bDead && !bFlying;
	bDrewFlightPanel = false;
	LastZone = 0;
	if (bDrewCrosshair)
	{
		const float Cx = W * 0.5f, Cy = H * 0.5f, Arm = 9.0f * Scale, Gap = 4.0f * Scale;
		if (const APlayerController* PC = GetOwningPlayerController(); PC && PC->PlayerCameraManager)
		{
			const UGameInstance* GameInstance = GetGameInstance();
			if (const UVibeNetSubsystem* Net = GameInstance ? GameInstance->GetSubsystem<UVibeNetSubsystem>() : nullptr)
			{
				LastZone = Net->AimTarget(PC->PlayerCameraManager->GetCameraLocation(), PC->PlayerCameraManager->GetCameraRotation().Vector());
			}
		}
		const FLinearColor C = LastZone == 2 ? FLinearColor(1.0f, 0.12f, 0.08f, 1.0f)
			: LastZone == 1 ? FLinearColor(1.0f, 0.35f, 0.3f, 0.95f) : FLinearColor(1.0f, 1.0f, 1.0f, 0.9f);
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

	// Melee cooldown (ui/MeleeHUD): a short bar under the crosshair until melee is ready again.
	if (Local.melee_cooldown_s > 0.0f && !bDead && !bFlying)
	{
		const float BW = 60.0f * Scale, BH = 4.0f * Scale, Y = H * 0.5f + 28.0f * Scale;
		const float Ready = 1.0f - FMath::Clamp(Local.melee_cooldown_s / MeleeCooldownS, 0.0f, 1.0f);
		DrawRect(FLinearColor(0.0f, 0.0f, 0.0f, 0.5f), (W - BW) * 0.5f, Y, BW, BH);
		DrawRect(FLinearColor(1.0f, 0.85f, 0.4f, 0.9f), (W - BW) * 0.5f, Y, BW * Ready, BH);
	}

	// Weapon, bottom right.
	if (const AVibePlayerPawn* Pawn = Cast<AVibePlayerPawn>(GetOwningPawn()); Pawn && !bFlying)
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
		// ui/SpawnProtectionHUD: the 3 s the server grants, counted from when it was granted.
		if (ProtectedSince < 0.0)
		{
			ProtectedSince = Now;
		}
		const float Remaining = FMath::Max(0.0f, SpawnProtectionS - static_cast<float>(Now - ProtectedSince));
		Banner(FString::Printf(TEXT("You are invulnerable for %.1fs"), Remaining), FLinearColor(0.6f, 0.9f, 1.0f), H * 0.62f);
	}
	if (!(Me.state_flags & VL_STATE_SPAWN_PROTECTED))
	{
		ProtectedSince = -1.0;
	}
	if (Now < ResetNoteUntil)
	{
		Banner(TEXT("City reset"), FLinearColor::White, H * 0.2f);
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
	if (bFlying)
	{
		bDrewFlightPanel = true;
		using EAction = FVibeSettings::EAction;
		const FVibeSettings& S = FVibeSettings::Get();
		auto K = [&S](EAction A) { return S.Key(A).GetDisplayName().ToString(); };
		const TArray<FString> Lines = Flyer->IsDropPending()
			? TArray<FString>{ TEXT("Dropping into the city…") }
			: TArray<FString>{
				TEXT("Aerial view"),
				TEXT("Explore freely. Return here to drop into the city."),
				FString::Printf(TEXT("%s/%s/%s/%s move · mouse look"), *K(EAction::MoveForward), *K(EAction::MoveLeft), *K(EAction::MoveBackward), *K(EAction::MoveRight)),
				FString::Printf(TEXT("%s rise · %s descend · %s boost"), *K(EAction::Jump), *K(EAction::Crouch), *K(EAction::Sprint)),
				FString::Printf(TEXT("Flight speed %d m/s (mouse wheel)"), Flyer->AerialSpeed()),
				FString::Printf(TEXT("%s  return to player"), *K(EAction::Aerial)),
			};
		float Y = 72.0f * Scale;
		const float PanelW = 300.0f * Scale;
		for (int32 i = 0; i < Lines.Num(); ++i)
		{
			float TextW = 0.0f, TextH = 0.0f;
			GetTextSize(Lines[i], TextW, TextH, GEngine->GetMediumFont());
			DrawText(Lines[i], i == 0 ? FLinearColor(0.4f, 0.9f, 1.0f) : FLinearColor::White, W - PanelW - 24.0f * Scale, Y, GEngine->GetMediumFont());
			Y += TextH + 4.0f * Scale;
		}
	}
	if (Local.energy >= 0.0f && Local.energy > 0.0f && Local.energy < LowEnergyThreshold)
	{
		Banner(TEXT("Low energy"), FLinearColor(1.0f, 0.8f, 0.2f), H * 0.68f);
	}
}
