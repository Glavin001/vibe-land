#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"

#include "VibeCityGameMode.generated.h"

class AVibeCityDirector;

/**
 * vibe-land's /city in Unreal: the player (AVibePlayerPawn), or with -VibeSpectate a free-flying spectator, over the city the server streams. Spawns the environment
 * (sun matching the web client's, sky, fog, ground) and the city director, connects using the
 * vibe-land settings (or -VibeApi / -VibeMatch), and frames the camera on the city once it is built.
 */
UCLASS()
class VIBECITY_API AVibeCityGameMode : public AGameModeBase
{
	GENERATED_BODY()

public:
	AVibeCityGameMode();

	virtual void StartPlay() override;
	virtual UClass* GetDefaultPawnClassForController_Implementation(AController* InController) override;

	/** -VibeSpectate or -VibeView=…: a free-flying spectator over the city instead of the player. */
	static bool IsSpectating();

private:
	void SpawnEnvironment();
	void FrameCity(const FBox& Bounds);

	UPROPERTY(Transient)
	TObjectPtr<AVibeCityDirector> Director;
};
