#include "VibeCityHUD.h"
#include "VibeSettings.h"

#include "CanvasItem.h"
#include "Engine/Canvas.h"
#include "Engine/Engine.h"
#include "Engine/Font.h"
#include "Engine/GameInstance.h"
#include "Engine/World.h"
#include "GameFramework/PlayerController.h"
#include "EngineUtils.h"
#include "VibeCityGrass.h"
#include "VibeNetSubsystem.h"
#include "VibePlayerPawn.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

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

void AVibeCityHUD::DrawStatus(float W, float H, float Scale, double Now, float Dt)
{
	const UGameInstance* GameInstance = GetGameInstance();
	const UVibeNetSubsystem* Net = GameInstance ? GameInstance->GetSubsystem<UVibeNetSubsystem>() : nullptr;
	if (!Net)
	{
		return;
	}
	UFont* Small = GEngine->GetSmallFont();
	// The pill, top left: refreshed once a second.
	const VlNetStats Link = Net->NetStats();
	const VlFrameView& F = Net->LastFrame();
	++PillFrames;
	if (Now - PillSince >= 1.0)
	{
		const double Span = PillSince > 0.0 ? Now - PillSince : 0.0;
		if (Span > 0.0)
		{
			const double Hz = (F.stats.newest_server_tick - PillTick0) / Span;
			const double Mbps = (Link.bytes_in - PillBytes0) * 8.0 / Span / 1e6;
			PillText = FString::Printf(TEXT("%d fps · server %.0f Hz · ping %.1f ms · %.2f Mbps"),
				FMath::RoundToInt(PillFrames / Span), Hz, Link.rtt_us / 1000.0, Mbps);
		}
		PillSince = Now;
		PillFrames = 0;
		PillTick0 = F.stats.newest_server_tick;
		PillBytes0 = Link.bytes_in;
	}
	if (!PillText.IsEmpty() && Net->IsConnected())
	{
		float TW = 0.0f, TH = 0.0f;
		GetTextSize(PillText, TW, TH, Small);
		const float X = 16.0f * Scale, Y = 14.0f * Scale;
		DrawRect(FLinearColor(0.0f, 0.0f, 0.0f, 0.45f), X - 6.0f, Y - 3.0f, TW + 12.0f, TH + 6.0f);
		DrawText(PillText, FLinearColor(0.85f, 0.95f, 1.0f), X, Y, Small);
	}
	// The banner (App.tsx's status line): joining, or why the session dropped and when it rejoins.
	FString Banner;
	if (!Net->IsConnected() && Net->WantsConnection())
	{
		const double In = FMath::Max(0.0, Net->ReconnectAtSeconds() - FPlatformTime::Seconds());
		Banner = Net->DropReason().IsEmpty() ? FString::Printf(TEXT("Connecting… (retry in %.0f s)"), In)
			: FString::Printf(TEXT("Connection lost: %s. Rejoining in %.0f s"), *Net->DropReason(), In);
	}
	else if (Net->IsConnected() && F.stats.state != 3)
	{
		static const TCHAR* Phases[] = { TEXT("Starting"), TEXT("Fetching the session"), TEXT("Loading the city"), TEXT("Connecting"), TEXT("Connected"), TEXT("Closed"), TEXT("Failed") };
		const uint32 P = FMath::Min<uint32>(F.transport_state, UE_ARRAY_COUNT(Phases) - 1);
		Banner = FString::Printf(TEXT("%s…"), Phases[P]);
	}
	if (!Banner.IsEmpty())
	{
		float TW = 0.0f, TH = 0.0f;
		GetTextSize(Banner, TW, TH, GEngine->GetMediumFont());
		DrawRect(FLinearColor(0.0f, 0.0f, 0.0f, 0.55f), (W - TW) * 0.5f - 12.0f, H * 0.08f - 6.0f, TW + 24.0f, TH + 12.0f);
		DrawText(Banner, FLinearColor(1.0f, 0.9f, 0.6f), (W - TW) * 0.5f, H * 0.08f, GEngine->GetMediumFont());
	}
}

void AVibeCityHUD::DrawControls(float W, float H, float Scale, bool bDriving)
{
	const APlayerController* PC = GetOwningPlayerController();
	if (!PC)
	{
		return;
	}
	using EAction = FVibeSettings::EAction;
	const FVibeSettings& S = FVibeSettings::Get();
	auto Down = [PC](const FKey& Key) { return PC->IsInputKeyDown(Key) ? 1.0f : 0.0f; };
	auto Analog = [PC](const FKey& Key) { return FMath::Clamp(FMath::Abs(PC->GetInputAnalogKeyState(Key)), 0.0f, 1.0f); };
	auto Act = [&](EAction A) { return Down(S.Key(A)); };
	auto Name = [&](EAction A) { return S.Key(A).GetDisplayName().ToString(); };
	float MouseX = 0.0f, MouseY = 0.0f;
	PC->GetInputMouseDelta(MouseX, MouseY);
	// The device last used (useControlHints.ts: the family of the latest input wins).
	const float Stick = FMath::Max(FVector2D(Analog(EKeys::Gamepad_LeftX), Analog(EKeys::Gamepad_LeftY)).Size(),
		FVector2D(Analog(EKeys::Gamepad_RightX), Analog(EKeys::Gamepad_RightY)).Size());
	const bool bPadNow = Stick > 0.2f || Analog(EKeys::Gamepad_RightTriggerAxis) > 0.2f || Analog(EKeys::Gamepad_LeftTriggerAxis) > 0.2f
		|| Down(EKeys::Gamepad_FaceButton_Bottom) + Down(EKeys::Gamepad_FaceButton_Right) + Down(EKeys::Gamepad_FaceButton_Left) + Down(EKeys::Gamepad_FaceButton_Top) > 0.0f;
	const bool bKeysNow = FMath::Abs(MouseX) + FMath::Abs(MouseY) > 0.0f || Down(EKeys::LeftMouseButton) > 0.0f
		|| Act(EAction::MoveForward) + Act(EAction::MoveBackward) + Act(EAction::MoveLeft) + Act(EAction::MoveRight) + Act(EAction::Jump) > 0.0f;
	bGamepadFamily = bPadNow ? true : bKeysNow ? false : bGamepadFamily;

	struct FRow { FString Command; FString Binding; float Value; };
	TArray<FRow> Rows;
	const float Move = FMath::Min(1.0f, FVector2D(Act(EAction::MoveRight) - Act(EAction::MoveLeft), Act(EAction::MoveForward) - Act(EAction::MoveBackward)).Size());
	const float Look = FMath::Min(1.0f, FVector2D(MouseX, MouseY).Size() / 8.0f);
	const float PadMove = FMath::Min(1.0f, FVector2D(Analog(EKeys::Gamepad_LeftX), Analog(EKeys::Gamepad_LeftY)).Size());
	const float PadLook = FMath::Min(1.0f, FVector2D(Analog(EKeys::Gamepad_RightX), Analog(EKeys::Gamepad_RightY)).Size());
	const FString Wasd = FString::Printf(TEXT("%s %s %s %s"), *Name(EAction::MoveForward), *Name(EAction::MoveLeft), *Name(EAction::MoveBackward), *Name(EAction::MoveRight));
	if (bDriving && bGamepadFamily)
	{
		Rows = {
			{ TEXT("Steer"), TEXT("Left Stick X"), Analog(EKeys::Gamepad_LeftX) },
			{ TEXT("Throttle"), TEXT("Right Trigger"), Analog(EKeys::Gamepad_RightTriggerAxis) },
			{ TEXT("Brake / Reverse"), TEXT("Left Trigger"), Analog(EKeys::Gamepad_LeftTriggerAxis) },
			{ TEXT("Camera"), TEXT("Right Stick"), PadLook },
			{ TEXT("Handbrake"), TEXT("A"), Down(EKeys::Gamepad_FaceButton_Bottom) },
			{ TEXT("Exit Vehicle"), TEXT("X"), Down(EKeys::Gamepad_FaceButton_Left) },
		};
	}
	else if (bDriving)
	{
		Rows = {
			{ TEXT("Steer"), FString::Printf(TEXT("%s / %s"), *Name(EAction::MoveLeft), *Name(EAction::MoveRight)), FMath::Max(Act(EAction::MoveLeft), Act(EAction::MoveRight)) },
			{ TEXT("Throttle"), Name(EAction::MoveForward), Act(EAction::MoveForward) },
			{ TEXT("Brake / Reverse"), Name(EAction::MoveBackward), Act(EAction::MoveBackward) },
			{ TEXT("Camera"), TEXT("Mouse / Trackpad"), Look },
			{ TEXT("Handbrake"), Name(EAction::Jump), Act(EAction::Jump) },
			{ TEXT("Reset Vehicle"), Name(EAction::Reset), Act(EAction::Reset) },
			{ TEXT("Exit Vehicle"), Name(EAction::Interact), Act(EAction::Interact) },
		};
	}
	else if (bGamepadFamily)
	{
		Rows = {
			{ TEXT("Move"), TEXT("Left Stick"), PadMove },
			{ TEXT("Look"), TEXT("Right Stick"), PadLook },
			{ TEXT("Shoot"), TEXT("Right Trigger"), Analog(EKeys::Gamepad_RightTriggerAxis) },
			{ TEXT("Aim"), TEXT("Left Trigger"), Analog(EKeys::Gamepad_LeftTriggerAxis) },
			{ TEXT("Melee"), TEXT("B"), Down(EKeys::Gamepad_FaceButton_Right) },
			{ TEXT("Jump"), TEXT("A"), Down(EKeys::Gamepad_FaceButton_Bottom) },
			{ TEXT("Sprint"), TEXT("Left Stick Press"), Down(EKeys::Gamepad_LeftThumbstick) },
			{ TEXT("Crouch"), TEXT("B"), Down(EKeys::Gamepad_FaceButton_Right) },
			{ TEXT("Interact / Car"), TEXT("X"), Down(EKeys::Gamepad_FaceButton_Left) },
			{ TEXT("Next Weapon"), TEXT("Y"), Down(EKeys::Gamepad_FaceButton_Top) },
		};
	}
	else
	{
		Rows = {
			{ TEXT("Move"), Wasd, Move },
			{ TEXT("Look"), TEXT("Mouse / Trackpad"), Look },
			{ TEXT("Shoot"), TEXT("Left Mouse"), Down(EKeys::LeftMouseButton) },
			{ TEXT("Aim"), FString::Printf(TEXT("Right Mouse / %s"), *Name(EAction::Aim)), FMath::Max(Down(EKeys::RightMouseButton), Act(EAction::Aim)) },
			{ TEXT("Melee"), Name(EAction::Melee), Act(EAction::Melee) },
			{ TEXT("Jump"), Name(EAction::Jump), Act(EAction::Jump) },
			{ TEXT("Sprint"), Name(EAction::Sprint), Act(EAction::Sprint) },
			{ TEXT("Crouch"), Name(EAction::Crouch), Act(EAction::Crouch) },
			{ TEXT("Interact / Car"), Name(EAction::Interact), Act(EAction::Interact) },
			{ TEXT("Rifle / Cannon / Meteor"), FString::Printf(TEXT("%s / %s / %s"), *Name(EAction::Rifle), *Name(EAction::Cannon), *Name(EAction::Meteor)),
				FMath::Max3(Act(EAction::Rifle), Act(EAction::Cannon), Act(EAction::Meteor)) },
			{ TEXT("Reset City"), Name(EAction::Reset), Act(EAction::Reset) },
			{ TEXT("Aerial Camera"), Name(EAction::Aerial), Act(EAction::Aerial) },
		};
	}
	LastControlRows = bControlsExpanded ? Rows.Num() : 0;
	LastControlsTitle = FString::Printf(TEXT("%s · %s"), bGamepadFamily ? TEXT("Gamepad") : TEXT("Keyboard + Mouse"), bDriving ? TEXT("Vehicle") : TEXT("On Foot"));

	UFont* Small = GEngine->GetSmallFont();
	const FLinearColor Shell(0.027f, 0.043f, 0.063f, 0.58f);
	const float Bottom = H - 16.0f * Scale;
	if (!bControlsExpanded)
	{
		const FString Chip = TEXT("▶ Controls  (F1)");
		float TW = 0.0f, TH = 0.0f;
		GetTextSize(Chip, TW, TH, Small);
		const float X = (W - TW) * 0.5f, Y = Bottom - TH - 8.0f * Scale;
		DrawRect(Shell, X - 10.0f * Scale, Y - 4.0f * Scale, TW + 20.0f * Scale, TH + 8.0f * Scale);
		DrawText(Chip, FLinearColor(1.0f, 1.0f, 1.0f, 0.82f), X, Y, Small);
		return;
	}
	// A grid of cells as the web lays its rows out: command, binding, and a bar of how hard it is held.
	constexpr int32 Columns = 4;
	const float CellW = 210.0f * Scale, CellH = 54.0f * Scale, Pad = 12.0f * Scale;
	const int32 Lines = (Rows.Num() + Columns - 1) / Columns;
	const float PanelW = Columns * CellW + 2.0f * Pad;
	const float HeaderH = 22.0f * Scale;
	const float PanelH = HeaderH + Lines * CellH + 2.0f * Pad;
	const float X0 = (W - PanelW) * 0.5f, Y0 = Bottom - PanelH;
	DrawRect(Shell, X0, Y0, PanelW, PanelH);
	DrawText(FString::Printf(TEXT("▼ Controls  ·  %s  ·  F1 folds"), *LastControlsTitle).ToUpper(), FLinearColor(1.0f, 1.0f, 1.0f, 0.9f), X0 + Pad, Y0 + Pad, Small);
	for (int32 i = 0; i < Rows.Num(); ++i)
	{
		const FRow& R = Rows[i];
		const float X = X0 + Pad + (i % Columns) * CellW;
		const float Y = Y0 + Pad + HeaderH + (i / Columns) * CellH;
		const bool bActive = R.Value > 0.05f;
		DrawText(R.Command, bActive ? FLinearColor(0.55f, 0.95f, 1.0f) : FLinearColor(1.0f, 1.0f, 1.0f, 0.9f), X, Y, Small);
		float TW = 0.0f, TH = 0.0f;
		GetTextSize(R.Binding, TW, TH, Small);
		DrawText(R.Binding, FLinearColor(1.0f, 1.0f, 1.0f, 0.55f), X, Y + TH, Small);
		const float BarY = Y + 2.0f * TH + 4.0f * Scale, BarW = CellW - 16.0f * Scale, BarH = 3.0f * Scale;
		DrawRect(FLinearColor(1.0f, 1.0f, 1.0f, 0.1f), X, BarY, BarW, BarH);
		DrawRect(FLinearColor(0.35f, 0.85f, 1.0f, 0.9f), X, BarY, BarW * FMath::Clamp(R.Value, 0.0f, 1.0f), BarH);
	}
}

void AVibeCityHUD::DrawGrassSync(float W, float H, float Scale)
{
	LastGrassSync.Reset();
	bool bError = false;
	if (TActorIterator<AVibeCityGrass> It(GetWorld()); It)
	{
		LastGrassSync = It->SyncMessage(bError);
	}
	if (LastGrassSync.IsEmpty())
	{
		return;
	}
	UFont* Small = GEngine->GetSmallFont();
	float TW = 0.0f, TH = 0.0f;
	GetTextSize(LastGrassSync, TW, TH, Small);
	const float X = (W - TW) * 0.5f, Y = 58.0f * Scale;
	DrawRect(FLinearColor(0.027f, 0.043f, 0.063f, 0.78f), X - 10.0f * Scale, Y - 5.0f * Scale, TW + 20.0f * Scale, TH + 10.0f * Scale);
	DrawText(LastGrassSync, bError ? FLinearColor(1.0f, 0.86f, 0.61f) : FLinearColor(0.85f, 0.91f, 0.78f), X, Y, Small);
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
	DrawStatus(Canvas->ClipX, Canvas->ClipY, Canvas->ClipY / 1080.0f, Now, Dt);

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
	// The controls panel, and the prompt by a car.
	if (const APlayerController* PC = GetOwningPlayerController(); PC && PC->WasInputKeyJustPressed(EKeys::F1))
	{
		ToggleControls();
	}
	LastControlRows = 0;
	if (const AVibePlayerPawn* Pawn = Cast<AVibePlayerPawn>(GetOwningPawn()); Pawn && !bFlying)
	{
		DrawControls(W, H, Scale, Pawn->IsInVehicle());
	}
	DrawGrassSync(W, H, Scale);
	if (const APlayerController* PC = GetOwningPlayerController(); PC && PC->WasInputKeyJustPressed(EKeys::F9))
	{
		ToggleStats();
	}
	DrawStats(W, H, Scale, Now, Dt);
	if (const AVibePlayerPawn* Pawn = Cast<AVibePlayerPawn>(GetOwningPawn()); Pawn && !bDead)
	{
		FString Hint;
		if (!Pawn->IsInVehicle() && Pawn->NearCar())
		{
			Hint = FString::Printf(TEXT("%s  drive"), *FVibeSettings::Get().Key(FVibeSettings::EAction::Interact).GetDisplayName().ToString());
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

void AVibeCityHUD::PollMatchStats(double Now)
{
	const UGameInstance* GameInstance = GetGameInstance();
	const UVibeNetSubsystem* Net = GameInstance ? GameInstance->GetSubsystem<UVibeNetSubsystem>() : nullptr;
	if (!Net || bStatsPolling || Now - StatsPolledAt < 1.0 || Net->CurrentApiBaseUrl().IsEmpty())
	{
		return;
	}
	bStatsPolling = true;
	StatsPolledAt = Now;
	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(Net->CurrentApiBaseUrl() / TEXT("match-stats") / Net->CurrentMatchId());
	Request->SetVerb(TEXT("GET"));
	Request->SetTimeout(5.0f);
	TWeakObjectPtr<AVibeCityHUD> Self(this);
	Request->OnProcessRequestComplete().BindLambda([Self](FHttpRequestPtr, FHttpResponsePtr Response, bool bOk) {
		AVibeCityHUD* Hud = Self.Get();
		if (!Hud)
		{
			return;
		}
		Hud->bStatsPolling = false;
		TSharedPtr<FJsonObject> Json;
		if (!bOk || !Response.IsValid() || Response->GetResponseCode() != 200
			|| !FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Response->GetContentAsString()), Json) || !Json.IsValid())
		{
			return;
		}
		// The headline numbers CityStatsOverlay leads with.
		TArray<TPair<FString, FString>> Rows;
		auto Num = [&Json](const TCHAR* Key) { double V = 0.0; return Json->TryGetNumberField(Key, V) ? V : -1.0; };
		auto Add = [&Rows](const FString& Label, const FString& Value) { Rows.Emplace(Label, Value); };
		FString Backend;
		Json->TryGetStringField(TEXT("physics_backend"), Backend);
		Add(TEXT("physics"), FString::Printf(TEXT("%s, step %.2f ms"), *Backend, Num(TEXT("physics_last_step_ms"))));
		Add(TEXT("server tick"), FString::Printf(TEXT("%.0f"), Num(TEXT("server_tick"))));
		Add(TEXT("players"), FString::Printf(TEXT("%.0f"), Num(TEXT("player_count"))));
		Add(TEXT("bodies awake / all"), FString::Printf(TEXT("%.0f / %.0f"), Num(TEXT("physics_active_dynamic_bodies")), Num(TEXT("dynamic_body_count"))));
		Add(TEXT("cars, batteries"), FString::Printf(TEXT("%.0f, %.0f"), Num(TEXT("vehicle_count")), Num(TEXT("battery_count"))));
		if (const TSharedPtr<FJsonObject>* City = nullptr; Json->TryGetObjectField(TEXT("city"), City) && City)
		{
			double Structures = 0.0, Wire = 0.0;
			(*City)->TryGetNumberField(TEXT("structures"), Structures);
			(*City)->TryGetNumberField(TEXT("wire_version"), Wire);
			const TSharedPtr<FJsonObject>* Step = nullptr;
			double StepP95 = -1.0;
			if ((*City)->TryGetObjectField(TEXT("window_step_ms"), Step) && Step)
			{
				(*Step)->TryGetNumberField(TEXT("p95"), StepP95);
			}
			Add(TEXT("city"), FString::Printf(TEXT("%.0f structures, wire %.0f, step p95 %.2f ms"), Structures, Wire, StepP95));
		}
		if (const TSharedPtr<FJsonObject>* Network = nullptr; Json->TryGetObjectField(TEXT("network"), Network) && Network)
		{
			double In = 0.0, Out = 0.0, Malformed = 0.0;
			(*Network)->TryGetNumberField(TEXT("inbound_bps"), In);
			(*Network)->TryGetNumberField(TEXT("outbound_bps"), Out);
			(*Network)->TryGetNumberField(TEXT("malformed_packets"), Malformed);
			Add(TEXT("server net"), FString::Printf(TEXT("in %.2f / out %.2f Mbps, %.0f malformed"), In * 8.0 / 1e6, Out * 8.0 / 1e6, Malformed));
		}
		Hud->ServerRows = MoveTemp(Rows);
	});
	Request->ProcessRequest();
}

void AVibeCityHUD::DrawStats(float W, float H, float Scale, double Now, float Dt)
{
	FrameTimes.Add(Dt);
	if (FrameTimes.Num() > 240)
	{
		FrameTimes.RemoveAt(0, FrameTimes.Num() - 240, EAllowShrinking::No);
	}
	LastServerRows = LastClientRows = 0;
	if (!bStatsOpen)
	{
		return;
	}
	PollMatchStats(Now);
	const UGameInstance* GameInstance = GetGameInstance();
	const UVibeNetSubsystem* Net = GameInstance ? GameInstance->GetSubsystem<UVibeNetSubsystem>() : nullptr;
	if (!Net)
	{
		return;
	}
	const VlStats& S = Net->LastFrame().stats;
	TArray<float> Sorted = FrameTimes;
	Sorted.Sort();
	double Sum = 0.0;
	for (const float T : FrameTimes)
	{
		Sum += T;
	}
	const double Fps = Sum > 0.0 ? FrameTimes.Num() / Sum : 0.0;
	const double P95 = Sorted.Num() ? Sorted[FMath::Min(Sorted.Num() - 1, FMath::FloorToInt(Sorted.Num() * 0.95))] * 1000.0 : 0.0;
	const TArray<TPair<FString, FString>> ClientRows = {
		{ TEXT("fps, frame p95"), FString::Printf(TEXT("%.0f, %.1f ms"), Fps, P95) },
		{ TEXT("chunks, bodies"), FString::Printf(TEXT("%u, %u"), S.chunks, S.live_bodies) },
		{ TEXT("players seen"), FString::Printf(TEXT("%u"), S.remote_players) },
		{ TEXT("snapshots"), FString::Printf(TEXT("%llu"), S.snapshots) },
		{ TEXT("keyframes (late)"), FString::Printf(TEXT("%llu (%llu)"), S.keyframes, S.late_keyframes) },
		{ TEXT("events, fractures"), FString::Printf(TEXT("%llu, %llu"), S.events_applied, S.fractures) },
		{ TEXT("hash checks / mismatches"), FString::Printf(TEXT("%llu / %llu"), S.hash_checks, S.hash_mismatches) },
		{ TEXT("bootstraps, resyncs"), FString::Printf(TEXT("%llu, %llu"), S.bootstraps, S.resync_requests) },
		{ TEXT("decode errors"), FString::Printf(TEXT("%llu"), S.decode_errors) },
	};
	UFont* Font = GEngine->GetSmallFont();
	const TArray<TPair<FString, FString>> Server = ServerRows.Num() ? ServerRows : TArray<TPair<FString, FString>>{ { TEXT("…"), TEXT("fetching match stats") } };
	const FString Title = FString::Printf(TEXT("Server · %s"), *Net->CurrentMatchId());
	const FString Footer = TEXT("F9 closes · R resets the city · 1/2/3 rifle, cannon, meteor");
	// Columns and rows sized from the text itself.
	float LabelW = 0.0f, ValueW = 0.0f, RowH = 0.0f, TW = 0.0f, TH = 0.0f;
	for (const TArray<TPair<FString, FString>>* Rows : { &Server, &ClientRows })
	{
		for (const TPair<FString, FString>& Row : *Rows)
		{
			GetTextSize(Row.Key, TW, TH, Font);
			LabelW = FMath::Max(LabelW, TW);
			RowH = FMath::Max(RowH, TH);
			GetTextSize(Row.Value, TW, TH, Font);
			ValueW = FMath::Max(ValueW, TW);
		}
	}
	GetTextSize(Footer, TW, TH, Font);
	const float Gap = 14.0f * Scale, Pad = 10.0f * Scale;
	const float PanelW = FMath::Max(LabelW + Gap + ValueW, TW);
	RowH += 3.0f * Scale;
	const float X = W - PanelW - Pad - 16.0f * Scale;
	float Y = 48.0f * Scale;
	const int32 Lines = Server.Num() + ClientRows.Num() + 3;
	DrawRect(FLinearColor(0.0f, 0.0f, 0.0f, 0.6f), X - Pad, Y - Pad, PanelW + 2.0f * Pad, Lines * RowH + RowH * 0.5f + 2.0f * Pad);
	auto Section = [&](const FString& Heading, const TArray<TPair<FString, FString>>& Rows) {
		DrawText(Heading, FLinearColor(0.4f, 0.9f, 1.0f), X, Y, Font);
		Y += RowH;
		for (const TPair<FString, FString>& Row : Rows)
		{
			DrawText(Row.Key, FLinearColor(0.75f, 0.75f, 0.75f), X, Y, Font);
			DrawText(Row.Value, FLinearColor::White, X + LabelW + Gap, Y, Font);
			Y += RowH;
		}
	};
	Section(Title, Server);
	Y += RowH * 0.5f;
	Section(TEXT("Client"), ClientRows);
	DrawText(Footer, FLinearColor(0.6f, 0.6f, 0.6f), X, Y, Font);
	LastServerRows = ServerRows.Num();
	LastClientRows = ClientRows.Num();
}
