#include "VibeCityEnvironment.h"

#include "Components/DirectionalLightComponent.h"
#include "Components/ExponentialHeightFogComponent.h"
#include "Components/PostProcessComponent.h"
#include "Components/SkyAtmosphereComponent.h"
#include "Components/SkyLightComponent.h"
#include "Materials/MaterialInterface.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "ProceduralMeshComponent.h"
#include "UObject/ConstructorHelpers.h"
#include "vibe_client_core.h"

namespace
{
	// The city world's ground: flat at server y = 0, ±256 m (client/src/world/cityWorld.ts).
	constexpr double GroundHalfExtentCm = 25600.0;
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
	Fog->SetFogDensity(0.002f);
	Fog->SetFogHeightFalloff(0.1f);

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
	BuildGround();
}

void AVibeCityEnvironment::BuildGround()
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

	const double R = GroundHalfExtentCm;
	const TArray<FVector> Vertices = { FVector(-R, -R, 0), FVector(R, -R, 0), FVector(R, R, 0), FVector(-R, R, 0) };
	TArray<FVector2D> UV0;
	for (const FVector& V : Vertices)
	{
		UV0.Add(FVector2D(-V.Y / 100.0 / TileM, V.X / 100.0 / TileM));
	}
	// The order Unreal draws as front faces seen from above (the core keeps the server's order,
	// which through the mirrored axes is clockwise from outside by the right-hand rule).
	const TArray<int32> Triangles = { 0, 3, 2, 0, 2, 1 };
	const TArray<FVector> Normals = { FVector::UpVector, FVector::UpVector, FVector::UpVector, FVector::UpVector };
	const TArray<FVector2D> UV1 = { LayerMetal, LayerMetal, LayerMetal, LayerMetal };
	const FProcMeshTangent Tangent(FVector(0, -1, 0), false);
	const TArray<FProcMeshTangent> Tangents = { Tangent, Tangent, Tangent, Tangent };
	static const TArray<FVector2D> NoUV;
	Ground->CreateMeshSection(0, Vertices, Triangles, Normals, UV0, UV1, NoUV, NoUV, TArray<FColor>(), Tangents, false);
}
