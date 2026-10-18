#include "VibeCityWeather.h"

#include "Components/ExponentialHeightFogComponent.h"
#include "EngineUtils.h"
#include "HAL/IConsoleManager.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Materials/MaterialInterface.h"
#include "Math/RandomStream.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "ProceduralMeshComponent.h"
#include "vibe_client_core.h"

namespace
{
	FLinearColor Srgb(uint32 Rgba)
	{
		return FLinearColor(FColor((Rgba >> 24) & 0xFF, (Rgba >> 16) & 0xFF, (Rgba >> 8) & 0xFF, 0xFF));
	}

	// The web draws a particle `size / distance` pixels across, a constant world size of size / f
	// metres for a focal length of f pixels. At the web's reference view (1080 drawing-buffer
	// pixels high, vertical FOV 75°): f = 540 / tan(37.5°).
	const float WebFocalPx = 540.0f / FMath::Tan(FMath::DegreesToRadians(37.5f));
	constexpr float MinIntensity = 0.25f; // fogSettings.ts MIN_FOG_INTENSITY
	constexpr float MaxIntensity = 5.0f;  // MAX_FOG_INTENSITY

	FAutoConsoleCommandWithWorldAndArgs GVibeWeather(
		TEXT("vibe.weather"),
		TEXT("vibe.weather clear|dust_storm|snow_storm [intensity]: the web's weather presets"),
		FConsoleCommandWithWorldAndArgsDelegate::CreateLambda([](const TArray<FString>& Args, UWorld* World) {
			if (!World || Args.Num() < 1)
			{
				return;
			}
			const int32 Preset = vl_weather_index(TCHAR_TO_UTF8(*Args[0]));
			const float Intensity = Args.Num() > 1 ? FCString::Atof(*Args[1]) : 1.0f;
			for (TActorIterator<AVibeCityWeather> It(World); It; ++It)
			{
				It->SetWeather(Preset, Intensity);
			}
		}));
}

AVibeCityWeather::AVibeCityWeather()
{
	PrimaryActorTick.bCanEverTick = false;
	Particles = CreateDefaultSubobject<UProceduralMeshComponent>(TEXT("Particles"));
	RootComponent = Particles;
	Particles->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	Particles->SetCastShadow(false);
	// The material moves every particle into a box around the camera: never cull the mesh. Build()
	// sizes its bounds to the whole play area (a fixed 10 000 scale put them hundreds of kilometres
	// out, past what the renderer's shadow views can place: DoubleFloat's OriginMax ensure).
}

AVibeCityWeather::FUnrealFog AVibeCityWeather::UnrealFog(float Intensity)
{
	// The web (CityEnvironment.tsx, fogSettings.ts): FogExp2 at density ρ·intensity, transmittance
	// exp(−(ρ·i·d)²), designed for opacity 0.55 at the server's area of interest R = 80 m
	// (shared/src/constants.rs PLAYER_AOI_RADIUS_M). Unreal's height fog with no falloff, along a
	// level ray past its start distance s (HeightFogCommon.ush: LineIntegral → ln 2; SceneCore.cpp:
	// density / 1000 per cm): transmittance exp(−k·(d − s)) with k = (D/1000)·(ln 2)² per cm.
	// Gaussian against exponential: match the web's transmittance and its slope at R, which gives
	// k = 2(ρi)²R and s = R/2 (within a few percent of the web from 0.75R to 1.75R).
	constexpr float AoiM = 80.0f;
	const float Rho = vl_weather_fog_exp2_density() * Intensity;
	const float KPerM = 2.0f * Rho * Rho * AoiM;
	return { KPerM / 100.0f * 1000.0f / (UE_LN2 * UE_LN2), AoiM * 0.5f * 100.0f };
}

void AVibeCityWeather::BeginPlay()
{
	Super::BeginPlay();
	FString Name = TEXT("clear");
	FParse::Value(FCommandLine::Get(), TEXT("VibeWeather="), Name);
	float Intensity = 1.0f;
	FParse::Value(FCommandLine::Get(), TEXT("VibeWeatherIntensity="), Intensity);
	SetWeather(vl_weather_index(TCHAR_TO_UTF8(*Name)), Intensity);
}

void AVibeCityWeather::SetWeather(int32 InPreset, float Intensity)
{
	const VlWeather* W = vl_weather(InPreset < 0 ? 0u : static_cast<uint32>(InPreset));
	if (!W)
	{
		return;
	}
	Intensity = FMath::Clamp(FMath::IsFinite(Intensity) ? Intensity : 1.0f, MinIntensity, MaxIntensity);
	CurrentPreset = InPreset < 0 ? 0 : InPreset;
	CurrentFogExp2 = vl_weather_fog_exp2_density() * Intensity;
	// CityEnvironment.tsx: the preset's fog colour, density × intensity.
	if (Fog)
	{
		Fog->SetFogInscatteringColor(Srgb(W->fog_rgba));
		const FUnrealFog F = UnrealFog(Intensity);
		Fog->SetFogDensity(F.Density);
		Fog->SetStartDistance(F.StartCm);
	}
	const float BoxCm = W->box_m * 100.0f;
	Build(static_cast<int32>(W->particle_count), BoxCm);
	if (W->particle_count == 0)
	{
		return;
	}
	UMaterialInterface* Base = LoadObject<UMaterialInterface>(nullptr,
		W->additive ? TEXT("/Game/VibeCity/Materials/M_VibeCityWeatherAdditive.M_VibeCityWeatherAdditive")
					: TEXT("/Game/VibeCity/Materials/M_VibeCityWeather.M_VibeCityWeather"),
		nullptr, LOAD_NoWarn | LOAD_Quiet);
	if (!Base)
	{
		UE_LOG(LogTemp, Display, TEXT("weather materials are not built (scripts/unreal/import-city-materials.sh); no particles"));
		Build(0, BoxCm);
		return;
	}
	Material = UMaterialInstanceDynamic::Create(Base, this);
	// WeatherParticles.tsx: wind × windFollow (the web's default wind), fall, tumble, and size
	// × sqrt(intensity).
	float Wind[3];
	vl_weather_wind(8.0f, 45.0f, Wind);
	float WindUe[3];
	vl_coords_pos_to_unreal(Wind[0] * W->wind_follow, Wind[1] * W->wind_follow, Wind[2] * W->wind_follow, WindUe);
	Material->SetVectorParameterValue(TEXT("Wind"), FLinearColor(WindUe[0], WindUe[1], WindUe[2], 0.0f));
	Material->SetScalarParameterValue(TEXT("BoxCm"), BoxCm);
	Material->SetScalarParameterValue(TEXT("Fall"), W->fall_mps * 100.0f);
	Material->SetScalarParameterValue(TEXT("TumbleHz"), W->tumble_hz);
	Material->SetScalarParameterValue(TEXT("TumbleCm"), W->tumble_m * 100.0f);
	Material->SetScalarParameterValue(TEXT("SizeCm"), 100.0f * W->particle_size_px * FMath::Sqrt(Intensity) / WebFocalPx);
	Material->SetVectorParameterValue(TEXT("Color"), Srgb(W->particle_rgba));
	Particles->SetMaterial(0, Material);
}

void AVibeCityWeather::Build(int32 Count, float BoxCm)
{
	// Bounds 10 km across around the world origin hold the camera's box anywhere in the city.
	Particles->SetBoundsScale(FMath::Max(1.0f, 1000000.0f / FMath::Max(BoxCm, 1.0f)));
	Particles->ClearAllMeshSections();
	Drawn = Count;
	if (Count <= 0)
	{
		return;
	}
	// WeatherParticles.tsx buildGeometry: uniform in the box, a seed each.
	FRandomStream Random(0x5EA7);
	TArray<FVector> Vertices;
	TArray<int32> Triangles;
	TArray<FVector2D> Corner, Seed;
	Vertices.Reserve(Count * 4);
	Triangles.Reserve(Count * 6);
	static const FVector2D Corners[4] = { FVector2D(0, 0), FVector2D(1, 0), FVector2D(1, 1), FVector2D(0, 1) };
	for (int32 i = 0; i < Count; ++i)
	{
		const FVector P((Random.FRand() - 0.5f) * BoxCm, (Random.FRand() - 0.5f) * BoxCm, (Random.FRand() - 0.5f) * BoxCm);
		const FVector2D S(Random.FRand(), 0.0f);
		const int32 First = Vertices.Num();
		for (const FVector2D& C : Corners)
		{
			Vertices.Add(P);
			Corner.Add(C);
			Seed.Add(S);
		}
		Triangles.Append({ First, First + 1, First + 2, First, First + 2, First + 3 });
	}
	static const TArray<FVector> NoNormals;
	static const TArray<FVector2D> NoUV;
	Particles->CreateMeshSection(0, Vertices, Triangles, NoNormals, Corner, Seed, NoUV, NoUV, TArray<FColor>(), TArray<FProcMeshTangent>(), false);
	if (Material)
	{
		Particles->SetMaterial(0, Material);
	}
}
