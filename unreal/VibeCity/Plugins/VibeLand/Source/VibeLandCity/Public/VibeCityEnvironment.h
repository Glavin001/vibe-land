#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"

#include "VibeCityEnvironment.generated.h"

class UDirectionalLightComponent;
class UExponentialHeightFogComponent;
class UMaterialInstanceDynamic;
class UMaterialInterface;
class UTexture2D;
class UPostProcessComponent;
class UProceduralMeshComponent;
class USkyAtmosphereComponent;
class USkyLightComponent;
class UVolumetricCloudComponent;
class AVibeCityWeather;
struct VlGrassPaint;

/**
 * The city's sky, light and ground, matching the web client's (client/src/scene/CityEnvironment.tsx,
 * client/src/graphics/sunSky.ts): the sun at the same elevation and azimuth, a physical sky
 * atmosphere with a sky light captured from it in real time (the web's hemisphere/ambient fill
 * becomes the sky's own light), height fog in the web's clear-weather colour, and the flat ±256 m
 * ground (server y = 0) wearing the catalog's ground material like any chunk. Weather presets
 * (AVibeCityWeather) recolour the fog and add dust or snow.
 */
UCLASS()
class VIBELANDCITY_API AVibeCityEnvironment : public AActor
{
	GENERATED_BODY()

public:
	AVibeCityEnvironment();

	virtual void BeginPlay() override;

	/** Re-tint the ground for a grass layout (null: the default meadow), as the web's ground takes
	 * its canopy colour from the grass paint (client-core grass.rs ground_tint). */
	void SetGroundCover(const VlGrassPaint* Paint);

	/** The web's sun (client/src/graphics/sunSky.ts DEFAULT_SUN_*). */
	static constexpr float SunElevationDeg = 39.3f;
	static constexpr float SunAzimuthDeg = 69.4f;

private:
	void BuildGround(const VlGrassPaint* Paint);

	UPROPERTY(VisibleAnywhere)
	TObjectPtr<UDirectionalLightComponent> Sun;

	UPROPERTY(VisibleAnywhere)
	TObjectPtr<USkyAtmosphereComponent> Atmosphere;

	UPROPERTY(VisibleAnywhere)
	TObjectPtr<USkyLightComponent> SkyLight;

	UPROPERTY(VisibleAnywhere)
	TObjectPtr<UExponentialHeightFogComponent> Fog;
	/** Volumetric clouds over the physical sky (an Unreal upgrade; off with -VibeNoVolumetrics). */
	UPROPERTY(VisibleAnywhere, Category = "Vibe")
	TObjectPtr<UVolumetricCloudComponent> Clouds;

	UPROPERTY(VisibleAnywhere)
	TObjectPtr<UPostProcessComponent> PostProcess;

	UPROPERTY(VisibleAnywhere)
	TObjectPtr<UProceduralMeshComponent> Ground;

	/** Dust and snow storms over the fog (the web's weather presets). */
	UPROPERTY(Transient)
	TObjectPtr<AVibeCityWeather> Weather;

	bool bHdGround = false;

	/** The ground's own material (M_VibeCityGroundHD) and its instance and macro-noise texture. */
	UPROPERTY(Transient)
	TObjectPtr<UMaterialInterface> GroundMaterial;
	UPROPERTY(Transient)
	TObjectPtr<UMaterialInstanceDynamic> GroundInstance;
	UPROPERTY(Transient)
	TObjectPtr<UTexture2D> MacroNoise;
};
