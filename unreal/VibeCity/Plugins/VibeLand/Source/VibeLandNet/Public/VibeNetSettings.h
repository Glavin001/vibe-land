#pragma once

#include "CoreMinimal.h"
#include "Engine/DeveloperSettings.h"

#include "VibeNetSettings.generated.h"

/** Where the client connects. Override per run with -VibeApi=http://host:port and -VibeMatch=citypp-…. */
UCLASS(Config = Game, DefaultConfig, meta = (DisplayName = "vibe-land"))
class VIBELANDNET_API UVibeNetSettings : public UDeveloperSettings
{
	GENERATED_BODY()

public:
	/** The server's HTTP origin (session config and the city manifest come from here). */
	UPROPERTY(Config, EditAnywhere, Category = "Connection")
	FString ApiBaseUrl = TEXT("http://127.0.0.1:4001");

	/** The match to join. The city must stream wire 4, so its id starts with "citypp". */
	UPROPERTY(Config, EditAnywhere, Category = "Connection")
	FString MatchId = TEXT("citypp-demo");

	/** Connect as soon as play begins. */
	UPROPERTY(Config, EditAnywhere, Category = "Connection")
	bool bAutoConnect = true;

	/** The settings with command-line overrides applied. */
	static void Resolve(FString& OutApiBaseUrl, FString& OutMatchId);
};
