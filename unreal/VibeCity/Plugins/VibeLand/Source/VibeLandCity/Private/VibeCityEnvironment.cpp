#include "VibeCityEnvironment.h"

#include "Components/DirectionalLightComponent.h"
#include "Components/ExponentialHeightFogComponent.h"
#include "Components/PostProcessComponent.h"
#include "Components/SkyAtmosphereComponent.h"
#include "Components/SkyLightComponent.h"
#include "Engine/World.h"
#include "Materials/MaterialInterface.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "ProceduralMeshComponent.h"
#include "VibeCityWeather.h"
#include "UObject/ConstructorHelpers.h"
#include "vibe_client_core.h"

namespace
{
	// The city world's ground: flat at server y = 0, ±256 m (client/src/world/cityWorld.ts).
	constexpr double GroundHalfExtentCm = 25600.0;
	// Past the ground, the web shows its fog-coloured background. Unreal fogs geometry only up to
	// the fog cutoff (so the sky stays clear, as the web's dome), so a skirt carries the ground on
	// to near the horizon, where the fog has made it the fog colour.
	constexpr double SkirtHalfExtentCm = 2000000.0;
	// client/src/graphics/weatherPresets.ts, clear: fog #b7c7d8.
	const FLinearColor ClearFogColor = FLinearColor(FColor(0xB7, 0xC7, 0xD8));
}

AVibeCityEnvironment::AVibeCityEnvironment()
{
	PrimaryActorTick.bCanEverTick = false;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));

	Sun = CreateDefaultSubobject<UDirectionalLightComponent>(TEXT("Sun"));
	Sun->SetupAttachment(RootComponent);
	Sun->SetMobility(EComponentMobility::Movable);
	Sun->SetAtmosphereSunLight(true);
	Sun->SetIntensity(8.0f);
	Sun->SetDynamicShadowDistanceMovableLight(20000.0f);
	Sun->SetDynamicShadowCascades(4);

	Atmosphere = CreateDefaultSubobject<USkyAtmosphereComponent>(TEXT("Atmosphere"));
	Atmosphere->SetupAttachment(RootComponent);

	// The sky's own light: captured from the atmosphere every frame, so shadowed walls are lit by
	// the sky as the web's hemisphere light lights them. The lower hemisphere is not black: the
	// ground is bright concrete and grass, and it lights the underside of everything.
	SkyLight = CreateDefaultSubobject<USkyLightComponent>(TEXT("SkyLight"));
	SkyLight->SetupAttachment(RootComponent);
	SkyLight->SetMobility(EComponentMobility::Movable);
	SkyLight->bRealTimeCapture = true;
	SkyLight->bLowerHemisphereIsBlack = false;
	SkyLight->SetLowerHemisphereColor(FLinearColor(0.35f, 0.33f, 0.30f));
	SkyLight->SetIntensity(1.0f);

	Fog = CreateDefaultSubobject<UExponentialHeightFogComponent>(TEXT("Fog"));
	Fog->SetupAttachment(RootComponent);
	Fog->SetFogInscatteringColor(ClearFogColor);
	// Uniform, as the web's FogExp2 (AVibeCityWeather sets the density from the preset).
	Fog->SetFogHeightFalloff(0.001f);
	// The web fogs geometry, not its sky dome: no fog past the ground's skirt.
	Fog->SetFogCutoffDistance(2.0 * SkirtHalfExtentCm * UE_SQRT_2);

	PostProcess = CreateDefaultSubobject<UPostProcessComponent>(TEXT("PostProcess"));
	PostProcess->SetupAttachment(RootComponent);
	PostProcess->bUnbound = true;

	Ground = CreateDefaultSubobject<UProceduralMeshComponent>(TEXT("Ground"));
	Ground->SetupAttachment(RootComponent);
	Ground->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	Ground->SetCastShadow(false);

	// The same chunk material the city wears (2K sources when built, as the director chooses).
	static ConstructorHelpers::FObjectFinderOptional<UMaterialInterface> Chunk(TEXT("/Game/VibeCity/Materials/M_VibeCityChunk.M_VibeCityChunk"));
	static ConstructorHelpers::FObjectFinderOptional<UMaterialInterface> Hd(TEXT("/Game/VibeCity/Materials/M_VibeCityChunkHD.M_VibeCityChunkHD"));
	bHdGround = Hd.Get() && !FParse::Param(FCommandLine::Get(), TEXT("VibeWebTextures"));
	if (UMaterialInterface* Material = bHdGround ? Hd.Get() : Chunk.Get())
	{
		Ground->SetMaterial(0, Material);
	}
}

void AVibeCityEnvironment::BeginPlay()
{
	Super::BeginPlay();

	// The light shines from the sun toward the ground. Toward-sun in server space (sunSky.ts
	// sunDirection), mapped to Unreal axes with the client core's own conversion.
	const float El = FMath::DegreesToRadians(SunElevationDeg);
	const float Az = FMath::DegreesToRadians(SunAzimuthDeg);
	float TowardSun[3];
	vl_coords_pos_to_unreal(FMath::Cos(El) * FMath::Sin(Az), FMath::Sin(El), FMath::Cos(El) * FMath::Cos(Az), TowardSun);
	const FVector SunDirection = FVector(TowardSun[0], TowardSun[1], TowardSun[2]).GetSafeNormal();
	Sun->SetWorldRotation((-SunDirection).Rotation());
	SkyLight->RecaptureSky();
	BuildGround(nullptr);
	FActorSpawnParameters Params;
	Params.Owner = this;
	Params.bDeferConstruction = true;
	Weather = GetWorld()->SpawnActor<AVibeCityWeather>(AVibeCityWeather::StaticClass(), FTransform::Identity, Params);
	if (Weather)
	{
		Weather->SetFog(Fog);
		Weather->FinishSpawning(FTransform::Identity);
	}
}

void AVibeCityEnvironment::SetGroundCover(const VlGrassPaint* Paint)
{
	BuildGround(Paint);
}

void AVibeCityEnvironment::BuildGround(const VlGrassPaint* Paint)
{
	// The catalog's grass, tiled at its real size, through the chunk material (UV0 = tiles,
	// UV1 = (layer, metalness)), with the box projection the core uses for top faces: u along
	// server +x (Unreal −y), v along server +z (Unreal +x).
	const VlMaterial* Catalog = nullptr;
	size_t Count = 0;
	vl_catalog(&Catalog, &Count);
	int32 Grass = INDEX_NONE;
	for (size_t i = 0; i < Count; ++i)
	{
		if (const char* Id = vl_catalog_id(static_cast<uint32>(i)); Id && FCStringAnsi::Strcmp(Id, "grass") == 0)
		{
			Grass = static_cast<int32>(i);
		}
	}
	const float TileM = Grass == INDEX_NONE ? 2.0f
		: (bHdGround && Catalog[Grass].hd_metres_per_tile > 0.0f ? Catalog[Grass].hd_metres_per_tile : Catalog[Grass].metres_per_tile);
	const FVector2D LayerMetal(Grass != INDEX_NONE ? Catalog[Grass].layer : 0, 0.0);

	// A grid on the grass paint's cover texels (2 m, groundNodes.ts samples GrassPaint.cover over
	// ±256 m), each vertex carrying the canopy tint the material multiplies the photograph by.
	constexpr int32 Cells = 256;
	const double R = GroundHalfExtentCm, Step = 2.0 * R / Cells;
	const int32 N = Cells + 1;
	TArray<FVector> Vertices;
	TArray<FVector2D> UV0, UV1;
	TArray<FVector> Normals;
	TArray<FColor> Colors;
	TArray<FProcMeshTangent> Tangents;
	Vertices.Reserve(N * N);
	UV0.Reserve(N * N);
	Colors.Reserve(N * N);
	const FProcMeshTangent Tangent(FVector(0, -1, 0), false);
	for (int32 j = 0; j < N; ++j)
	{
		for (int32 i = 0; i < N; ++i)
		{
			const FVector V(-R + i * Step, -R + j * Step, 0.0);
			Vertices.Add(V);
			const float X = -V.Y / 100.0, Z = V.X / 100.0; // server metres
			UV0.Add(FVector2D(X / TileM, Z / TileM));
			UV1.Add(LayerMetal);
			Normals.Add(FVector::UpVector);
			Tangents.Add(Tangent);
			float Tint[3];
			vl_grass_ground_tint(Paint, X, Z, Tint);
			// Linear, as the material reads it (the core's colours are linear).
			Colors.Add(FLinearColor(FMath::Clamp(Tint[0], 0.0f, 1.0f), FMath::Clamp(Tint[1], 0.0f, 1.0f), FMath::Clamp(Tint[2], 0.0f, 1.0f)).ToFColor(false));
		}
	}
	// The order Unreal draws as front faces seen from above (the core keeps the server's order,
	// which through the mirrored axes is clockwise from outside by the right-hand rule).
	TArray<int32> Triangles;
	Triangles.Reserve(Cells * Cells * 6);
	for (int32 j = 0; j < Cells; ++j)
	{
		for (int32 i = 0; i < Cells; ++i)
		{
			const int32 A = j * N + i, B = A + 1, C = A + N, D = C + 1;
			Triangles.Append({ A, C, D, A, D, B });
		}
	}
	static const TArray<FVector2D> NoUV;
	Ground->CreateMeshSection(0, Vertices, Triangles, Normals, UV0, UV1, NoUV, NoUV, Colors, Tangents, false);

	// The skirt: a ring from the ground's edge out to SkirtHalfExtentCm, white (untinted).
	const double S = SkirtHalfExtentCm;
	const TArray<FVector> Ring = { FVector(-R, -R, 0), FVector(R, -R, 0), FVector(R, R, 0), FVector(-R, R, 0),
		FVector(-S, -S, 0), FVector(S, -S, 0), FVector(S, S, 0), FVector(-S, S, 0) };
	TArray<FVector2D> RingUV0, RingUV1;
	for (const FVector& V : Ring)
	{
		RingUV0.Add(FVector2D(-V.Y / 100.0 / TileM, V.X / 100.0 / TileM));
		RingUV1.Add(LayerMetal);
	}
	// Each side's quad (inner i, i+1; outer i+4, i+5), wound like the grid's.
	TArray<int32> RingTriangles;
	for (int32 i = 0; i < 4; ++i)
	{
		const int32 A = i, B = (i + 1) % 4, C = i + 4, D = (i + 1) % 4 + 4;
		RingTriangles.Append({ A, B, D, A, D, C });
	}
	const TArray<FVector> RingNormals = { FVector::UpVector, FVector::UpVector, FVector::UpVector, FVector::UpVector,
		FVector::UpVector, FVector::UpVector, FVector::UpVector, FVector::UpVector };
	TArray<FProcMeshTangent> RingTangents;
	RingTangents.Init(Tangent, Ring.Num());
	Ground->CreateMeshSection(1, Ring, RingTriangles, RingNormals, RingUV0, RingUV1, NoUV, NoUV, TArray<FColor>(), RingTangents, false);
	if (UMaterialInterface* Material = Ground->GetMaterial(0))
	{
		Ground->SetMaterial(1, Material);
	}
}
