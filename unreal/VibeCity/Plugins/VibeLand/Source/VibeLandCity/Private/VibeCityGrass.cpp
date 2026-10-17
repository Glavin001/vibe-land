#include "VibeCityGrass.h"

#include "Async/Async.h"
#include "Camera/PlayerCameraManager.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "VibeCityEnvironment.h"
#include "GameFramework/PlayerController.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Materials/MaterialInterface.h"
#include "ProceduralMeshComponent.h"
#include "UObject/ConstructorHelpers.h"

namespace
{
	// grass.rs: 8 m patches, drawn out to 48 m (the web's pretty profile), up to 150 blades per m².
	constexpr float PatchSizeM = 8.0f;
	constexpr float DrawDistanceM = 48.0f;
	constexpr float DensityPretty = 150.0f;
	// Patches are released a little past the draw distance, so standing on a boundary does not
	// churn them.
	constexpr float ReleaseDistanceM = DrawDistanceM + 12.0f;
	constexpr float UpdateEvery = 0.2f;
	// GrassLayoutSync.ts: one conditional request per two seconds, ten-second timeout.
	constexpr float PollEvery = 2.0f;
	constexpr float PollTimeout = 10.0f;
	// Distance LOD bands (fractions of a patch's blades), chosen from grass.rs density_at_distance.
	constexpr float Bands[] = { 1.0f, 0.7f, 0.45f, 0.28f, 0.16f };

	int32 BandFor(float DistanceM)
	{
		// grass.rs density_at_distance (pretty), then the nearest band at or above it.
		auto Smooth = [DistanceM](float A, float B) {
			const float T = FMath::Clamp((DistanceM - A) / (B - A), 0.0f, 1.0f);
			return T * T * (3.0f - 2.0f * T);
		};
		const float Density = (1.0f - 0.55f * Smooth(8.0f, 16.0f)) * (1.0f - 0.65f * Smooth(19.5f, 30.0f));
		int32 Band = 0;
		for (int32 b = 0; b < UE_ARRAY_COUNT(Bands); ++b)
		{
			if (Bands[b] >= Density)
			{
				Band = b;
			}
		}
		return Band;
	}

	// Server metres (x, z on the ground) to Unreal centimetres, as the core's coordinate map does.
	FVector Ground(float X, float Z) { return FVector(100.0 * Z, -100.0 * X, 0.0); }
}

AVibeCityGrass::AVibeCityGrass()
{
	PrimaryActorTick.bCanEverTick = true;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	static ConstructorHelpers::FObjectFinderOptional<UMaterialInterface> Grass(TEXT("/Game/VibeCity/Materials/M_VibeCityGrass.M_VibeCityGrass"));
	GrassMaterial = Grass.Get();
}

void AVibeCityGrass::SetExclusions(TArrayView<const VlGrassExclusion> InExclusions)
{
	Exclusions = TArray<VlGrassExclusion>(InExclusions.GetData(), InExclusions.Num());
	bHasExclusions = true;
}

int32 AVibeCityGrass::PaintTiles() const
{
	return Paint ? static_cast<int32>(vl_grass_paint_tiles(Paint->Handle)) : 0;
}

void AVibeCityGrass::Generate(FPatch& Patch, FIntPoint Key)
{
	TArray<VlGrassExclusion> Ex = Exclusions;
	TSharedPtr<FPaint, ESPMode::ThreadSafe> Over = Paint;
	const int32 Px = Key.X, Pz = Key.Y;
	Patch.Pending = Async(EAsyncExecution::ThreadPool, [Ex = MoveTemp(Ex), Over = MoveTemp(Over), Px, Pz]() {
		TArray<VlGrassBlade> Blades;
		Blades.SetNumUninitialized(12000);
		const size_t Count = vl_grass_patch(Over ? Over->Handle : nullptr, Ex.GetData(), Ex.Num(), Px, Pz, DensityPretty, Blades.GetData(), Blades.Num());
		Blades.SetNum(FMath::Min<int32>(static_cast<int32>(Count), Blades.Num()));
		return Blades;
	});
}

void AVibeCityGrass::PollLayout()
{
	if (LayoutUrl.IsEmpty() || bPolling)
	{
		return;
	}
	bPolling = true;
	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(LayoutUrl);
	Request->SetVerb(TEXT("GET"));
	Request->SetTimeout(PollTimeout);
	if (!Revision.IsEmpty())
	{
		Request->SetHeader(TEXT("If-None-Match"), FString::Printf(TEXT("\"%s\""), *Revision));
	}
	TWeakObjectPtr<AVibeCityGrass> Self(this);
	Request->OnProcessRequestComplete().BindLambda([Self](FHttpRequestPtr, FHttpResponsePtr Response, bool bOk) {
		AVibeCityGrass* Grass = Self.Get();
		if (!Grass)
		{
			return;
		}
		Grass->bPolling = false;
		Grass->SincePoll = 0.0f;
		// 304: unchanged. Errors keep the last shared layout (or the default meadow).
		if (!bOk || !Response.IsValid() || Response->GetResponseCode() != 200)
		{
			return;
		}
		const TArray<uint8>& Body = Response->GetContent();
		ANSICHAR Rev[65] = {};
		VlGrassPaint* Parsed = vl_grass_paint_parse(Body.GetData(), Body.Num(), Rev, sizeof(Rev));
		if (!Parsed)
		{
			return;
		}
		Grass->Paint = MakeShared<FPaint, ESPMode::ThreadSafe>(Parsed);
		// The ground takes its canopy tint from the same layout.
		for (TActorIterator<AVibeCityEnvironment> It(Grass->GetWorld()); It; ++It)
		{
			It->SetGroundCover(Parsed);
		}
		Grass->Revision = UTF8_TO_TCHAR(Rev);
		Grass->GeneratedOnPaint = 0;
		// Regenerate every patch over the new layout; each keeps its blades until the new land.
		for (TPair<FIntPoint, FPatch>& Pair : Grass->Patches)
		{
			Grass->Generate(Pair.Value, Pair.Key);
		}
	});
	Request->ProcessRequest();
}

void AVibeCityGrass::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	SincePoll += DeltaSeconds;
	if (SincePoll >= PollEvery)
	{
		PollLayout();
	}
	if (!bHasExclusions || !GrassMaterial)
	{
		return;
	}
	// Finished generations become meshes as soon as they land.
	for (TPair<FIntPoint, FPatch>& Pair : Patches)
	{
		FPatch& Patch = Pair.Value;
		if (Patch.Pending.IsValid() && Patch.Pending.IsReady())
		{
			Patch.Blades = Patch.Pending.Get();
			Patch.Pending = TFuture<TArray<VlGrassBlade>>();
			Patch.bReady = true;
			Patch.Band = -1;
			++GeneratedOnPaint;
		}
	}
	SinceUpdate += DeltaSeconds;
	if (SinceUpdate < UpdateEvery)
	{
		return;
	}
	SinceUpdate = 0.0f;
	const APlayerController* Controller = GetWorld()->GetFirstPlayerController();
	if (!Controller || !Controller->PlayerCameraManager)
	{
		return;
	}
	const FVector Camera = Controller->PlayerCameraManager->GetCameraLocation();
	// Camera in server metres: x = −Y/100, z = X/100, height y = Z/100.
	const float Cx = -Camera.Y / 100.0f, Cz = Camera.X / 100.0f, Cy = FMath::Max(0.0f, Camera.Z / 100.0f - 0.8f);
	const int32 Reach = FMath::CeilToInt(ReleaseDistanceM / PatchSizeM);
	const int32 Px0 = FMath::FloorToInt(Cx / PatchSizeM), Pz0 = FMath::FloorToInt(Cz / PatchSizeM);
	auto DistanceTo = [&](int32 Px, int32 Pz) {
		// grassPlacement.ts grassPatchDistance: to the nearest point of the patch, height included.
		const float Dx = FMath::Max3(Px * PatchSizeM - Cx, 0.0f, Cx - (Px + 1) * PatchSizeM);
		const float Dz = FMath::Max3(Pz * PatchSizeM - Cz, 0.0f, Cz - (Pz + 1) * PatchSizeM);
		return FMath::Sqrt(Dx * Dx + Dz * Dz + Cy * Cy);
	};
	for (int32 Pz = Pz0 - Reach; Pz <= Pz0 + Reach; ++Pz)
	{
		for (int32 Px = Px0 - Reach; Px <= Px0 + Reach; ++Px)
		{
			const float D = DistanceTo(Px, Pz);
			if (D > DrawDistanceM)
			{
				continue;
			}
			FPatch* Patch = Patches.Find(FIntPoint(Px, Pz));
			if (!Patch)
			{
				Patch = &Patches.Add(FIntPoint(Px, Pz));
				Generate(*Patch, FIntPoint(Px, Pz));
				continue;
			}
			if (Patch->bReady)
			{
				const int32 Band = BandFor(D);
				if (Band != Patch->Band)
				{
					Rebuild(*Patch, Band);
				}
			}
		}
	}
	// Release patches well out of range.
	for (auto It = Patches.CreateIterator(); It; ++It)
	{
		if (DistanceTo(It.Key().X, It.Key().Y) > ReleaseDistanceM && (It.Value().bReady || !It.Value().Pending.IsValid()))
		{
			if (UProceduralMeshComponent* Mesh = It.Value().Mesh)
			{
				Meshes.Remove(Mesh);
				Mesh->DestroyComponent();
			}
			It.RemoveCurrent();
		}
	}
}

void AVibeCityGrass::Rebuild(FPatch& Patch, int32 Band)
{
	Patch.Band = Band;
	if (!Patch.Mesh)
	{
		UProceduralMeshComponent* Mesh = NewObject<UProceduralMeshComponent>(this);
		Mesh->SetupAttachment(RootComponent);
		Mesh->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		Mesh->SetCastShadow(false);
		Mesh->bUseAsyncCooking = false;
		Mesh->RegisterComponent();
		Patch.Mesh = Mesh;
		Meshes.Add(Mesh);
	}
	// The first n blades cover the whole patch (grass.rs order), so the LOD is a prefix.
	const int32 Count = FMath::Clamp(FMath::RoundToInt(Patch.Blades.Num() * Bands[Band]), 0, Patch.Blades.Num());
	Patch.Drawn = Count;
	TArray<FVector> Vertices;
	TArray<int32> Triangles;
	TArray<FVector> Normals;
	TArray<FColor> Colors;
	Vertices.Reserve(Count * 5);
	Triangles.Reserve(Count * 18);
	Normals.Reserve(Count * 5);
	Colors.Reserve(Count * 5);
	// Fewer blades far away are drawn wider so the meadow keeps its cover (grassNodes.ts divides
	// a merged blade's width by the LOD density).
	const float WidthScale = 1.0f / Bands[Band];
	for (int32 i = 0; i < Count; ++i)
	{
		const VlGrassBlade& B = Patch.Blades[i];
		const FVector Root = Ground(B.x, B.z);
		// The blade's flat side faces along (cos yaw, sin yaw) in server x/z, and it leans that way.
		const FVector Across = FVector(FMath::Sin(B.yaw), -FMath::Cos(B.yaw), 0.0);
		const FVector Facing = FVector(FMath::Cos(B.yaw), FMath::Sin(B.yaw), 0.0);
		const float HalfWidth = B.width * 50.0f * WidthScale;
		const float HeightCm = B.height * 100.0f;
		// Two segments, tapering as (1 − t²) and bending as t² (grassNodes.ts).
		auto At = [&](float T) { return Root + Facing * (B.lean * HeightCm * T * T) + FVector::UpVector * (HeightCm * T); };
		const FVector Normal = (Facing * 0.5f + FVector::UpVector).GetSafeNormal();
		auto Shade = [&](float T) {
			const float K = 0.55f + 0.55f * T;
			return FLinearColor(FMath::Min(1.0f, B.color[0] * K), FMath::Min(1.0f, B.color[1] * K), FMath::Min(1.0f, B.color[2] * K), T).ToFColor(false);
		};
		const int32 First = Vertices.Num();
		const FVector Mid = At(0.5f);
		Vertices.Append({ Root - Across * HalfWidth, Root + Across * HalfWidth, Mid - Across * (HalfWidth * 0.75f), Mid + Across * (HalfWidth * 0.75f), At(1.0f) });
		// Both faces (the material is one-sided so neither face's normal is flipped downward).
		Triangles.Append({ First, First + 2, First + 1, First + 1, First + 2, First + 3, First + 2, First + 4, First + 3 });
		Triangles.Append({ First, First + 1, First + 2, First + 1, First + 3, First + 2, First + 2, First + 3, First + 4 });
		Normals.Append({ Normal, Normal, Normal, Normal, Normal });
		// Vertex colours reach the material as written: the core's colours are linear already.
		Colors.Append({ Shade(0.0f), Shade(0.0f), Shade(0.5f), Shade(0.5f), Shade(1.0f) });
	}
	static const TArray<FVector2D> NoUV;
	static const TArray<FProcMeshTangent> NoTangents;
	Patch.Mesh->ClearAllMeshSections();
	if (Count > 0)
	{
		Patch.Mesh->CreateMeshSection(0, Vertices, Triangles, Normals, NoUV, Colors, NoTangents, false);
		Patch.Mesh->SetMaterial(0, GrassMaterial);
	}
}

int32 AVibeCityGrass::DrawnPatches() const
{
	int32 N = 0;
	for (const TPair<FIntPoint, FPatch>& Pair : Patches)
	{
		N += Pair.Value.Mesh && Pair.Value.Drawn > 0 ? 1 : 0;
	}
	return N;
}

int64 AVibeCityGrass::DrawnBlades() const
{
	int64 N = 0;
	for (const TPair<FIntPoint, FPatch>& Pair : Patches)
	{
		N += Pair.Value.Drawn;
	}
	return N;
}
