#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"

#include "VibeCityEnvironment.generated.h"

class UDirectionalLightComponent;
class UExponentialHeightFogComponent;
class UPostProcessComponent;
class UProceduralMeshComponent;
class USkyAtmosphereComponent;
class USkyLightComponent;

/**
 * The city's sky, light and ground, matching the web client's (client/src/scene/CityEnvironment.tsx,
 * client/src/graphics/sunSky.ts): the sun at the same elevation and azimuth, a physical sky
 * atmosphere with a sky light captured from it in real time (the web's hemisphere/ambient fill
 * becomes the sky's own light), height fog in the web's clear-weather colour, and the flat ±256 m
 * ground (server y = 0) wearing the catalog's ground material like any chunk.
 */
UCLASS()
class VIBELANDCITY_API AVibeCityEnvironment : public AActor
{
	GENERATED_BODY()

public:
	AVibeCityEnvironment();

	virtual void BeginPlay() override;

	/** The web's sun (client/src/graphics/sunSky.ts DEFAULT_SUN_*). */
	static constexpr float SunElevationDeg = 39.3f;
	static constexpr float SunAzimuthDeg = 69.4f;

private:
	void BuildGround();

	UPROPERTY(VisibleAnywhere)
	TObjectPtr<UDirectionalLightComponent> Sun;

	UPROPERTY(VisibleAnywhere)
	TObjectPtr<USkyAtmosphereComponent> Atmosphere;

	UPROPERTY(VisibleAnywhere)
	TObjectPtr<USkyLightComponent> SkyLight;

	UPROPERTY(VisibleAnywhere)
	TObjectPtr<UExponentialHeightFogComponent> Fog;

	UPROPERTY(VisibleAnywhere)
	TObjectPtr<UPostProcessComponent> PostProcess;

	UPROPERTY(VisibleAnywhere)
	TObjectPtr<UProceduralMeshComponent> Ground;
};
