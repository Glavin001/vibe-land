#pragma once

#include "CoreMinimal.h"
#include "GameFramework/HUD.h"
#include "vibe_client_core.h"

#include "VibeCityHUD.generated.h"

/**
 * The web /city HUD (client/src/App.tsx and ui/): crosshair, red over a player the shot would hit
 * (the server's hitscan classifier through the core); health and energy bars (ui/EnergyBar); the
 * weapon (ui/WeaponHud); damage from where it came (ui/useDamageFeedback: front/back/left/right
 * lobes and a vignette, held while dead); the scope's darkening and reticle while aiming; the melee
 * cooldown (ui/MeleeHUD); the low-energy warning; spawn protection's countdown
 * (ui/SpawnProtectionHUD); death; a note when the city resets; the performance pill (fps, server
 * tick rate, ping, download) and the connection banner (connecting, or why it dropped and when it
 * rejoins). Values come from the core.
 * The controls panel (ControlHintsOverlay.tsx) and the shared grass status (GrassLayoutSync.ts).
 * While the aerial camera flies (or a drop is on its way) it draws no crosshair or weapon and shows
 * the web's flight panel instead (CityFlightControls.tsx).
 */
UCLASS()
class VIBECITY_API AVibeCityHUD : public AHUD
{
	GENERATED_BODY()

public:
	/** What the last frame drew (tests): the crosshair, and the aerial camera's flight panel. */
	bool DrewCrosshair() const { return bDrewCrosshair; }
	bool DrewFlightPanel() const { return bDrewFlightPanel; }
	/** The crosshair's target zone last frame (0 none, 1 body, 2 head), and damage lobes drawn. */
	uint32 CrosshairZone() const { return LastZone; }
	int32 ActiveDamage() const { return Damage.Num(); }

protected:
	virtual void BeginPlay() override;
	virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;
	virtual void DrawHUD() override;

private:
	void OnFrame(const VlFrameView& Frame);
	void Bar(float X, float Y, float W, float H, float Fraction, const FLinearColor& Color, const FString& Label);

	struct FDamage
	{
		float Peak = 0.0f;
		float Front = 0.0f, Back = 0.0f, Left = 0.0f, Right = 0.0f;
		double Started = 0.0;
	};
	void DrawEdges(float W, float H, float Front, float Back, float Left, float Right, float Vignette);

	VlLocal Local = {};
	TArray<FDamage> Damage;
	float ScopeBlend = 0.0f;
	double ProtectedSince = -1.0;
	uint64 Bootstraps = 0;
	double ResetNoteUntil = 0.0;
	uint32 LastZone = 0;
	/** The performance pill's running numbers (CityStatsOverlay's fps / server Hz / ping / Mbps). */
	double PillSince = 0.0;
	int32 PillFrames = 0;
	uint32 PillTick0 = 0;
	uint64 PillBytes0 = 0;
	FString PillText;
	void DrawStatus(float W, float H, float Scale, double Now, float Dt);
	/** The web's ControlHintsOverlay: every command with its binding and how hard it is held now,
	 * for the device last used (keyboard and mouse, or gamepad) and on foot or driving. Expanded at
	 * first, as on /city; F1 folds it. Hidden while flying, as the web hides it in the aerial view. */
	void DrawControls(float W, float H, float Scale, bool bDriving);
	bool bControlsExpanded = true;
	bool bGamepadFamily = false;
	/** The shared grass layout's status line (App.tsx under the top of the screen). */
	void DrawGrassSync(float W, float H, float Scale);
public:
	/** What the controls panel drew last frame (tests): rows, and its title. */
	int32 ControlRows() const { return LastControlRows; }
	const FString& ControlsTitle() const { return LastControlsTitle; }
	const FString& GrassSyncShown() const { return LastGrassSync; }
	/** Fold or unfold the controls panel (F1). */
	void ToggleControls() { bControlsExpanded = !bControlsExpanded; }
private:
	int32 LastControlRows = 0;
	FString LastControlsTitle;
	FString LastGrassSync;
	double LastDrawTime = 0.0;
	FDelegateHandle FrameHandle;
	bool bDrewCrosshair = false;
	bool bDrewFlightPanel = false;
};
