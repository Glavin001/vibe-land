#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"

#include "VibeCityWeather.generated.h"

class UExponentialHeightFogComponent;
class UMaterialInstanceDynamic;
class UProceduralMeshComponent;

/**
 * The web's weather (client-core weather.rs, a port of client/src/graphics/weatherPresets.ts and
 * scene/WeatherParticles.tsx): a preset recolours the fog and fills a box around the camera with
 * dust or snow. The particles are one procedural mesh of camera-facing quads whose material
 * (M_VibeCityWeather[Additive], the web's vertex shader as HLSL) drifts them with the wind and
 * fall, tumbles them, and wraps them inside the box, so the CPU only sets a few parameters.
 *
 * Choose with -VibeWeather=clear|dust_storm|snow_storm (and -VibeWeatherIntensity=), or in game
 * with `vibe.weather <name> [intensity]`.
 */
UCLASS()
class VIBELANDCITY_API AVibeCityWeather : public AActor
{
	GENERATED_BODY()

public:
	AVibeCityWeather();

	/** The preset (VL_WEATHER_*) at a thickness (the web's intensity, 0.25 to 5). */
	void SetWeather(int32 Preset, float Intensity);
	/** The fog this weather recolours and thickens (the environment's). */
	void SetFog(UExponentialHeightFogComponent* InFog) { Fog = InFog; }

	/** Unreal's height fog (density, start distance in cm) matching the web's FogExp2 at an
	 * intensity (see the .cpp for the derivation). */
	struct FUnrealFog
	{
		float Density;
		float StartCm;
	};
	static FUnrealFog UnrealFog(float Intensity);

	int32 Preset() const { return CurrentPreset; }
	/** For tests: particles drawn now. */
	int32 DrawnParticles() const { return Drawn; }

protected:
	virtual void BeginPlay() override;

private:
	void Build(int32 Count, float BoxCm);

	UPROPERTY(VisibleAnywhere)
	TObjectPtr<UProceduralMeshComponent> Particles;
	UPROPERTY(Transient)
	TObjectPtr<UMaterialInstanceDynamic> Material;
	UPROPERTY(Transient)
	TObjectPtr<UExponentialHeightFogComponent> Fog;

	int32 CurrentPreset = -1;
	int32 Drawn = 0;
};
