#pragma once

#include "CoreMinimal.h"
#include "GameFramework/HUD.h"
#include "vibe_client_core.h"

#include "VibeCityHUD.generated.h"

/**
 * The web /city HUD's essentials (client/src/App.tsx): crosshair, health and energy bars
 * (ui/EnergyBar), the selected weapon (ui/WeaponHud), a red flash when hit (DamageOverlay), the
 * low-energy warning, spawn protection and death. Values come from the core's local-player record.
 */
UCLASS()
class VIBECITY_API AVibeCityHUD : public AHUD
{
	GENERATED_BODY()

protected:
	virtual void BeginPlay() override;
	virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;
	virtual void DrawHUD() override;

private:
	void OnFrame(const VlFrameView& Frame);
	void Bar(float X, float Y, float W, float H, float Fraction, const FLinearColor& Color, const FString& Label);

	VlLocal Local = {};
	float DamageFlash = 0.0f;
	double LastDrawTime = 0.0;
	FDelegateHandle FrameHandle;
};
