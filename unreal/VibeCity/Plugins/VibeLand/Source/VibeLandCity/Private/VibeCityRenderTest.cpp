// VibeCity.Render.CityAndEffects: the city renderer against a live PhysX server.
//
//  * every chunk is drawn: the vertices in standing cells plus on bodies equal the core's chunk
//    meshes' vertices less the removed chunks', before and after a fracture;
//  * chunks wear the generated catalog material (not the fallback);
//  * the meadow has patches drawn around the camera;
//  * a meteor's fractures, watched from 35 m by the camera (the listener), reach the frame as
//    sounds, loops (air, scrapes, debris beds) and dust, and dust puffs appear.
//
// Run in the game on a citypp match (scripts/unreal/play-tests.sh --only VibeCity.Render.CityAndEffects).

#include "EngineUtils.h"
#include "Engine/Engine.h"
#include "Engine/GameInstance.h"
#include "Engine/World.h"
#include "HAL/IConsoleManager.h"
#include "Camera/PlayerCameraManager.h"
#include "GameFramework/HUD.h"
#include "GameFramework/PlayerController.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Misc/AutomationTest.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Tests/AutomationCommon.h"
#include "UObject/UObjectIterator.h"
#include "UnrealClient.h"
#include "Engine/StaticMesh.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Components/StaticMeshComponent.h"
#include "Rendering/NaniteResources.h"
#include "StaticMeshResources.h"
#include "VibeCityCapture.h"
#include "VibeCityCells.h"
#include "VibeCityDirector.h"
#include "Components/ExponentialHeightFogComponent.h"
#include "VibeCityGrass.h"
#include "VibeCityWeather.h"
#include "VibeNetSubsystem.h"
#include "vibe_client_core.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace
{
	UWorld* GameWorld()
	{
		if (!GEngine)
		{
			return nullptr;
		}
		for (const FWorldContext& Context : GEngine->GetWorldContexts())
		{
			if ((Context.WorldType == EWorldType::Game || Context.WorldType == EWorldType::PIE) && Context.World())
			{
				return Context.World();
			}
		}
		return nullptr;
	}

	template <typename T>
	T* Find()
	{
		UWorld* World = GameWorld();
		if (!World)
		{
			return nullptr;
		}
		for (TActorIterator<T> It(World); It; ++It)
		{
			return *It;
		}
		return nullptr;
	}

	UVibeNetSubsystem* Net()
	{
		UWorld* World = GameWorld();
		UGameInstance* Instance = World ? World->GetGameInstance() : nullptr;
		return Instance ? Instance->GetSubsystem<UVibeNetSubsystem>() : nullptr;
	}

	void Post(const FString& Url, const FString& Body)
	{
		TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
		Request->SetURL(Url);
		Request->SetVerb(TEXT("POST"));
		Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
		Request->SetContentAsString(Body);
		Request->ProcessRequest();
	}

}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FVibeCityRenderCityAndEffects, "VibeCity.Render.CityAndEffects",
	EAutomationTestFlags::ClientContext | EAutomationTestFlags::ProductFilter)

bool FVibeCityRenderCityAndEffects::RunTest(const FString& Parameters)
{
	struct FState
	{
		double Started = 0.0;
		int64 SoundsAtMeteor = 0;
		int64 DustAtMeteor = 0;
		int64 LoopsAtMeteor = 0;
		int32 PeakDust = 0;
		uint64 FracturesAtMeteor = 0;
	};
	TSharedRef<FState> State = MakeShared<FState>();

	// The city, built, on a fresh copy of the match's city.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([State]() {
		UVibeNetSubsystem* N = Net();
		if (!N || N->LastFrame().stats.state < 3)
		{
			return false;
		}
		Post(N->CurrentApiBaseUrl() / TEXT("city-reset") / N->CurrentMatchId(), TEXT(""));
		State->Started = FPlatformTime::Seconds();
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(3.0f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this]() {
		AVibeCityDirector* Director = Find<AVibeCityDirector>();
		if (!Director || !Director->IsCityBuilt())
		{
			return false;
		}
		TestTrue(TEXT("chunks wear the generated catalog material"), Director->UsesCatalogMaterial());
		const int64 Expected = Director->ExpectedVertices();
		const int64 Drawn = Director->DrawnCellVertices() + Director->DrawnBodyVertices();
		TestEqual(TEXT("every chunk's vertices are drawn (cells + bodies)"), Drawn, Expected);
		AddInfo(FString::Printf(TEXT("drawn %lld vertices (%lld in cells, %lld on bodies); core %lld; removed chunks %d"),
			Drawn, Director->DrawnCellVertices(), Director->DrawnBodyVertices(), Expected, Director->RemovedChunks()));
		return true;
	}));
	// The meadow, around the camera.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, State]() {
		AVibeCityGrass* Grass = Find<AVibeCityGrass>();
		if (Grass && Grass->DrawnPatches() > 4)
		{
			AddInfo(FString::Printf(TEXT("meadow: %d patches, %lld blades"), Grass->DrawnPatches(), Grass->DrawnBlades()));
			TestTrue(TEXT("meadow blades drawn"), Grass->DrawnBlades() > 1000);
			return true;
		}
		if (FPlatformTime::Seconds() - State->Started > 30.0)
		{
			AddError(TEXT("no meadow patches drawn within 30 s"));
			return true;
		}
		return false;
	}));
	// A meteor on the first building's highest chunk (as vl-headless aims one).
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([State]() {
		UVibeNetSubsystem* N = Net();
		AVibeCityDirector* Director = Find<AVibeCityDirector>();
		if (!N || !Director)
		{
			return true;
		}
		const TArrayView<const VlChunk> Chunks = N->Chunks();
		if (Chunks.Num() == 0)
		{
			return true;
		}
		const uint32 First = Chunks[0].structure;
		const VlChunk* Top = &Chunks[0];
		for (const VlChunk& C : Chunks)
		{
			if (C.structure == First && C.rest_pos[2] > Top->rest_pos[2])
			{
				Top = &C;
			}
		}
		// Unreal (cm, x fwd, y right, z up) to server (m): x = −Y/100, y = Z/100, z = X/100.
		const FVector3f Target(-Top->rest_pos[1] / 100.0f, Top->rest_pos[2] / 100.0f, Top->rest_pos[0] / 100.0f);
		const FString Body = FString::Printf(TEXT("{\"targets\":[[%f,%f,%f]]}"), Target.X, Target.Y, Target.Z);
		// Watch (and listen) from 35 m off: sounds are heard from the camera, as on the web.
		VibeCityCapture::Park(GameWorld(), Target + FVector3f(25.0f, 8.0f, 25.0f), Target, 0.0f);
		Post(N->CurrentApiBaseUrl() / TEXT("city-meteor") / N->CurrentMatchId(), Body);
		State->SoundsAtMeteor = Director->SoundsSeen();
		State->DustAtMeteor = Director->DustSeen();
		State->LoopsAtMeteor = Director->LoopsSeen();
		State->FracturesAtMeteor = N->LastFrame().stats.fractures;
		State->Started = FPlatformTime::Seconds();
		return true;
	}));
	// Fractures reach the frame as sounds and dust; dust puffs appear; drawing still accounts for
	// every chunk.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, State]() {
		UVibeNetSubsystem* N = Net();
		AVibeCityDirector* Director = Find<AVibeCityDirector>();
		if (!N || !Director)
		{
			AddError(TEXT("lost the director"));
			return true;
		}
		State->PeakDust = FMath::Max(State->PeakDust, Director->LiveDust());
		const uint64 Fractures = N->LastFrame().stats.fractures - State->FracturesAtMeteor;
		// The server runs slow when it shares the GPU: allow a minute for the meteor to land.
		const bool bTimedOut = FPlatformTime::Seconds() - State->Started > 60.0;
		if (Fractures == 0 && !bTimedOut)
		{
			return false;
		}
		if (Fractures > 0 && FPlatformTime::Seconds() - State->Started < 4.0)
		{
			return false; // let the debris fly a few seconds
		}
		// Cell meshes rebuild on workers, a frame behind their last change: compare on a frame with
		// none in flight.
		if (Director->CellBuildsPending() && FPlatformTime::Seconds() - State->Started < 30.0)
		{
			return false;
		}
		TestTrue(TEXT("the meteor fractured the building"), Fractures > 0);
		TestTrue(TEXT("fractures reached the frame as sounds"), Director->SoundsSeen() > State->SoundsAtMeteor);
		TestTrue(TEXT("fractures reached the frame as dust"), Director->DustSeen() > State->DustAtMeteor);
		TestTrue(TEXT("dust puffs drawn"), State->PeakDust > 0);
		TestEqual(TEXT("every remaining chunk's vertices are drawn after the fracture"),
			Director->DrawnCellVertices() + Director->DrawnBodyVertices(), Director->ExpectedVertices());
		TestTrue(TEXT("debris drawn on bodies"), Director->DrawnBodyVertices() > 0);
		AddInfo(FString::Printf(TEXT("loops (air, scrapes, debris beds) over the meteor: %lld loop-frames"), Director->LoopsSeen() - State->LoopsAtMeteor));
		TestTrue(TEXT("loops (air, scrapes, debris beds) heard near the impact"), Director->LoopsSeen() > State->LoopsAtMeteor);
		AddInfo(FString::Printf(TEXT("after the meteor: %llu fractures, %lld sounds, %lld dust (peak %d live), %lld body vertices"),
			Fractures, Director->SoundsSeen() - State->SoundsAtMeteor, Director->DustSeen() - State->DustAtMeteor, State->PeakDust, Director->DrawnBodyVertices()));
		return true;
	}));
	return true;
}

// VibeCity.Render.WeatherAndGrass: the web's weather presets and shared painted grass.
//
//  * `vibe.weather snow_storm` fills the camera box with the preset's 5000 particles and turns
//    the fog the preset's colour; `vibe.weather clear` empties it and restores the clear fog;
//  * the shared grass layout loads from the server (the stored city-default layout, 84 painted
//    tiles) and every patch around the camera regenerates over it.
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FVibeCityRenderWeatherAndGrass, "VibeCity.Render.WeatherAndGrass",
	EAutomationTestFlags::ClientContext | EAutomationTestFlags::ProductFilter)

bool FVibeCityRenderWeatherAndGrass::RunTest(const FString& Parameters)
{
	struct FState
	{
		double Started = 0.0;
		int32 Patches = 0;
	};
	TSharedRef<FState> State = MakeShared<FState>();
	auto FogColor = []() {
		UWorld* World = GameWorld();
		for (TObjectIterator<UExponentialHeightFogComponent> It; It; ++It)
		{
			if (It->GetWorld() == World)
			{
				return It->FogInscatteringLuminance;
			}
		}
		return FLinearColor::Transparent;
	};
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, FogColor]() {
		AVibeCityWeather* Weather = Find<AVibeCityWeather>();
		if (!Weather)
		{
			return false;
		}
		const VlWeather* Snow = vl_weather(static_cast<uint32>(vl_weather_index("snow_storm")));
		IConsoleManager::Get().ProcessUserConsoleInput(TEXT("vibe.weather snow_storm"), *GLog, GameWorld());
		TestEqual(TEXT("snow storm particles"), Weather->DrawnParticles(), static_cast<int32>(Snow->particle_count));
		const FLinearColor Want(FColor((Snow->fog_rgba >> 24) & 0xFF, (Snow->fog_rgba >> 16) & 0xFF, (Snow->fog_rgba >> 8) & 0xFF));
		TestTrue(FString::Printf(TEXT("snow storm fog %s is the preset's %s"), *FogColor().ToString(), *Want.ToString()), FogColor().Equals(Want, 1e-3f));
		IConsoleManager::Get().ProcessUserConsoleInput(TEXT("vibe.weather clear"), *GLog, GameWorld());
		TestEqual(TEXT("clear: no particles"), Weather->DrawnParticles(), 0);
		const VlWeather* Clear = vl_weather(0);
		TestTrue(TEXT("clear fog restored"), FogColor().Equals(FLinearColor(FColor((Clear->fog_rgba >> 24) & 0xFF, (Clear->fog_rgba >> 16) & 0xFF, (Clear->fog_rgba >> 8) & 0xFF)), 1e-3f));
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([State]() {
		UVibeNetSubsystem* N = Net();
		AVibeCityGrass* Grass = Find<AVibeCityGrass>();
		if (!N || !Grass || Grass->DrawnPatches() < 4)
		{
			return false;
		}
		Grass->SetLayoutUrl(N->CurrentApiBaseUrl() / TEXT("match-stats/city-default/grass"));
		State->Patches = Grass->DrawnPatches();
		State->Started = FPlatformTime::Seconds();
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, State]() {
		AVibeCityGrass* Grass = Find<AVibeCityGrass>();
		if (!Grass)
		{
			AddError(TEXT("lost the grass"));
			return true;
		}
		// The match's own (empty) layout may land first: wait for the painted one.
		const bool bLoaded = Grass->PaintTiles() > 0 && Grass->PatchesOnCurrentPaint() >= State->Patches;
		if (!bLoaded && FPlatformTime::Seconds() - State->Started < 20.0)
		{
			return false;
		}
		TestEqual(TEXT("shared layout revision is 64 hex digits"), Grass->PaintRevision().Len(), 64);
		TestEqual(TEXT("painted tiles of the stored city-default layout"), Grass->PaintTiles(), 84);
		TestTrue(FString::Printf(TEXT("patches regenerated over the layout (%d of %d)"), Grass->PatchesOnCurrentPaint(), State->Patches),
			Grass->PatchesOnCurrentPaint() >= State->Patches);
		AddInfo(FString::Printf(TEXT("layout %s: %d tiles; %d patches, %lld blades"), *Grass->PaintRevision().Left(8), Grass->PaintTiles(), Grass->DrawnPatches(), Grass->DrawnBlades()));
		return true;
	}));
	return true;
}

// VibeCity.Render.Compare: the same view as the web's, for a side-by-side comparison. Parks the
// camera at -VibeCapture=px,py,pz,tx,ty,tz[,fov] (server metres; default the web replay's rig,
// (0, 14, 140) looking at (0, 6, 0)) on a fresh city, waits for the meadow, and saves
// compare-unreal.png to -VibeShotDir= (the web's twin: window.__VIBE_E2E__.setCapturePose with the
// same pose).
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FVibeCityRenderCompare, "VibeCity.Render.Compare",
	EAutomationTestFlags::ClientContext | EAutomationTestFlags::ProductFilter)

bool FVibeCityRenderCompare::RunTest(const FString& Parameters)
{
	TSharedRef<double> Started = MakeShared<double>(0.0);
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Started]() {
		UVibeNetSubsystem* N = Net();
		AVibeCityDirector* Director = Find<AVibeCityDirector>();
		if (!N || !Director || !Director->IsCityBuilt())
		{
			return false;
		}
		FString Text = TEXT("0,14,140,0,6,0");
		FParse::Value(FCommandLine::Get(), TEXT("VibeCapture="), Text, /*bShouldStopOnSeparator=*/false);
		FVector3f P, T;
		float Fov = 0.0f;
		TestTrue(TEXT("capture pose parses"), VibeCityCapture::Parse(Text, P, T, Fov));
		TestTrue(TEXT("camera parked"), VibeCityCapture::Park(GameWorld(), P, T, Fov));
		*Started = FPlatformTime::Seconds();
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Started]() {
		AVibeCityGrass* Grass = Find<AVibeCityGrass>();
		const bool bSettled = Grass && Grass->DrawnPatches() > 4 && FPlatformTime::Seconds() - *Started > 6.0;
		if (!bSettled && FPlatformTime::Seconds() - *Started < 30.0)
		{
			return false;
		}
		FString ShotDir;
		if (FParse::Value(FCommandLine::Get(), TEXT("VibeShotDir="), ShotDir))
		{
			FScreenshotRequest::RequestScreenshot(ShotDir / TEXT("compare-unreal.png"), false, false);
			AddInfo(FString::Printf(TEXT("screenshot: %s"), *(ShotDir / TEXT("compare-unreal.png"))));
		}
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(2.0f));
	return true;
}

// VibeCity.Render.Species: painted reeds, wheat, corn and ferns drawn with their own shapes. Loads
// client-core/tests/fixtures/grass_species_layout.json (four plots painted with the web's brushes
// in front of the comparison pose), requires plants of each species drawn, and saves species.png
// to -VibeShotDir= from beside the plots; the distant canopy is built over them (species-far.png
// from 63 m).
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FVibeCityRenderSpecies, "VibeCity.Render.Species",
	EAutomationTestFlags::ClientContext | EAutomationTestFlags::ProductFilter)

bool FVibeCityRenderSpecies::RunTest(const FString& Parameters)
{
	TSharedRef<double> Started = MakeShared<double>(0.0);
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Started]() {
		AVibeCityGrass* Grass = Find<AVibeCityGrass>();
		if (!Grass || Grass->DrawnPatches() < 4)
		{
			return false;
		}
		const FString Path = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir() / TEXT("../../client-core/tests/fixtures/grass_species_layout.json"));
		TArray<uint8> Body;
		TestTrue(TEXT("species layout fixture read"), FFileHelper::LoadFileToArray(Body, *Path));
		Grass->SetLayoutUrl(FString());
		TestTrue(TEXT("species layout applied"), Grass->ApplyLayout(Body));
		VibeCityCapture::Park(GameWorld(), FVector3f(0.0f, 3.0f, 131.0f), FVector3f(0.0f, 0.8f, 122.0f), 0.0f);
		*Started = FPlatformTime::Seconds();
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Started]() {
		AVibeCityGrass* Grass = Find<AVibeCityGrass>();
		bool bAll = Grass != nullptr;
		for (uint32 S = 1; bAll && S <= 4; ++S)
		{
			bAll = Grass->DrawnOfSpecies(S) > 0;
		}
		if (!bAll && FPlatformTime::Seconds() - *Started < 30.0)
		{
			return false;
		}
		const TCHAR* Names[] = { TEXT("grass"), TEXT("reed"), TEXT("wheat"), TEXT("corn"), TEXT("fern") };
		for (uint32 S = 1; S <= 4; ++S)
		{
			const int64 N = Grass ? Grass->DrawnOfSpecies(S) : 0;
			TestTrue(FString::Printf(TEXT("%s plants drawn (%lld)"), Names[S], N), N > 0);
		}
		FString ShotDir;
		if (FParse::Value(FCommandLine::Get(), TEXT("VibeShotDir="), ShotDir))
		{
			FScreenshotRequest::RequestScreenshot(ShotDir / TEXT("species.png"), false, false);
		}
		// The distant canopy (FoliageCanopy.ts) over the painted stands.
		TestTrue(FString::Printf(TEXT("canopy clumps built over the painted stands (%d)"), Grass ? Grass->CanopyClumps() : 0), Grass && Grass->CanopyClumps() > 0);
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(2.0f));
	// From 63 m, where the blades have handed off to the canopy.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([]() {
		VibeCityCapture::Park(GameWorld(), FVector3f(0.0f, 12.0f, 184.0f), FVector3f(0.0f, 1.0f, 122.0f), 0.0f);
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(3.0f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([]() {
		FString ShotDir;
		if (FParse::Value(FCommandLine::Get(), TEXT("VibeShotDir="), ShotDir))
		{
			FScreenshotRequest::RequestScreenshot(ShotDir / TEXT("species-far.png"), false, false);
		}
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(2.0f));
	return true;
}

// VibeCity.Render.ImportedCity: the city imported for this manifest (scripts/unreal/import-city.sh)
// draws its intact cells as Nanite static meshes, each exactly its cell: the triangles Nanite was
// built from equal the cell's intact chunks' triangles, and each has a mesh distance field (Lumen).
// A meteor on one swaps the cells it breaks to their runtime meshes (every vertex still drawn), and
// a city reset brings the imported meshes back.
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FVibeCityRenderImportedCity, "VibeCity.Render.ImportedCity",
	EAutomationTestFlags::ClientContext | EAutomationTestFlags::ProductFilter)

bool FVibeCityRenderImportedCity::RunTest(const FString& Parameters)
{
	struct FState
	{
		double Deadline = 0.0;
		int32 Cell = INDEX_NONE;
	};
	TSharedRef<FState> S = MakeShared<FState>();
	auto WaitFor = [S](TFunction<bool()> Done, double Seconds)
	{
		if (S->Deadline == 0.0)
		{
			S->Deadline = FPlatformTime::Seconds() + Seconds;
		}
		const bool bOver = Done() || FPlatformTime::Seconds() > S->Deadline;
		if (bOver)
		{
			S->Deadline = 0.0;
		}
		return bOver;
	};
	// Built, and every intact cell drawing its imported mesh (cells broken before this run draw their
	// runtime meshes; a reset at the end brings them all back).
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S, WaitFor]()
	{
		if (!WaitFor([] { AVibeCityDirector* D = Find<AVibeCityDirector>(); return D && D->IsCityBuilt(); }, 120.0))
		{
			return false;
		}
		AVibeCityDirector* D = Find<AVibeCityDirector>();
		if (!D || !D->IsCityBuilt())
		{
			AddError(TEXT("the city was not built"));
			return true;
		}
		int32 Imported = 0, Matching = 0, WithField = 0, Nanite = 0;
		for (int32 Cell = 0; Cell < D->CellCount(); ++Cell)
		{
			const UStaticMesh* Mesh = D->ImportedCellMesh(Cell);
			if (!Mesh)
			{
				continue;
			}
			++Imported;
			const FStaticMeshRenderData* Data = Mesh->GetRenderData();
			Nanite += Mesh->HasValidNaniteData() ? 1 : 0;
			const int64 Built = Data && Data->NaniteResourcesPtr.IsValid() ? Data->NaniteResourcesPtr->NumInputTriangles : -1;
			Matching += Built == D->CellTriangles(Cell, false) ? 1 : 0;
			WithField += Data && Data->LODResources.Num() > 0 && Data->LODResources[0].DistanceFieldData != nullptr ? 1 : 0;
			if (S->Cell == INDEX_NONE)
			{
				S->Cell = Cell;
			}
		}
		AddInfo(FString::Printf(TEXT("%d of %d cells imported: %d Nanite, %d with their cell's triangles, %d with a distance field"),
			Imported, D->CellCount(), Nanite, Matching, WithField));
		if (Imported == 0)
		{
			AddError(TEXT("no imported city for this manifest: scripts/unreal/import-city.sh --match <this match>"));
			S->Cell = INDEX_NONE;
			return true;
		}
		TestEqual(TEXT("every imported cell is Nanite"), Nanite, Imported);
		TestEqual(TEXT("every imported cell holds exactly its cell's triangles"), Matching, Imported);
		TestEqual(TEXT("every imported cell has a mesh distance field (Lumen)"), WithField, Imported);
		TestEqual(TEXT("all vertices drawn"), D->DrawnCellVertices() + D->DrawnBodyVertices(), D->ExpectedVertices());

		// A meteor on the highest chunk of the first imported cell.
		UVibeNetSubsystem* N = Net();
		const TArrayView<const VlChunk> Chunks = N ? N->Chunks() : TArrayView<const VlChunk>();
		FVector Target = FVector(0.0, 0.0, -1.0e9);
		for (int32 i = 0; i < Chunks.Num(); ++i)
		{
			const FVector P = VibeCityCells::RestTransform(Chunks[i]).GetLocation();
			if (D->CellOfChunk(i) == S->Cell && P.Z > Target.Z)
			{
				Target = P;
			}
		}
		// Server space: (x, y, z) = (-Y, Z, X) / 100.
		Post(N->CurrentApiBaseUrl() / TEXT("city-meteor") / N->CurrentMatchId(),
			FString::Printf(TEXT("{\"targets\":[[%f,%f,%f]]}"), -Target.Y / 100.0, Target.Z / 100.0, Target.X / 100.0));
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S, WaitFor]()
	{
		if (S->Cell == INDEX_NONE)
		{
			return true;
		}
		if (!WaitFor([S] { AVibeCityDirector* D = Find<AVibeCityDirector>(); return D && !D->ImportedCellMesh(S->Cell); }, 30.0))
		{
			return false;
		}
		AVibeCityDirector* D = Find<AVibeCityDirector>();
		TestTrue(TEXT("the struck cell swapped to its runtime mesh"), D && !D->ImportedCellMesh(S->Cell));
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(3.0f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S]()
	{
		if (S->Cell == INDEX_NONE)
		{
			return true;
		}
		AVibeCityDirector* D = Find<AVibeCityDirector>();
		if (D)
		{
			AddInfo(FString::Printf(TEXT("after the meteor: %d cells imported, %d removed chunks"), D->ImportedCellsDrawn(), D->RemovedChunks()));
			TestEqual(TEXT("all vertices drawn after the swap"), D->DrawnCellVertices() + D->DrawnBodyVertices(), D->ExpectedVertices());
		}
		return true;
	}));
	// Once still, a broken cell is baked back into a static mesh with a distance field (Lumen sees it).
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S, WaitFor]()
	{
		if (S->Cell == INDEX_NONE)
		{
			return true;
		}
		if (!WaitFor([] { AVibeCityDirector* D = Find<AVibeCityDirector>(); return D && D->BakedCellsDrawn() > 0; }, 40.0))
		{
			return false;
		}
		AVibeCityDirector* D = Find<AVibeCityDirector>();
		int32 WithField = 0, Baked = 0;
		for (int32 Cell = 0; D && Cell < D->CellCount(); ++Cell)
		{
			if (const UStaticMesh* Mesh = D->BakedCellMesh(Cell))
			{
				++Baked;
				const FStaticMeshRenderData* Data = Mesh->GetRenderData();
				WithField += Data && Data->LODResources.Num() > 0 && Data->LODResources[0].DistanceFieldData != nullptr ? 1 : 0;
			}
		}
		AddInfo(FString::Printf(TEXT("baked broken cells: %d, %d with a distance field"), Baked, WithField));
		TestTrue(TEXT("a broken cell was baked"), Baked > 0);
		TestEqual(TEXT("every baked cell has a distance field"), WithField, Baked);
		if (D)
		{
			TestEqual(TEXT("all vertices still drawn"), D->DrawnCellVertices() + D->DrawnBodyVertices(), D->ExpectedVertices());
		}
		UVibeNetSubsystem* N = Net();
		Post(N->CurrentApiBaseUrl() / TEXT("city-reset") / N->CurrentMatchId(), TEXT("{}"));
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S, WaitFor]()
	{
		if (S->Cell == INDEX_NONE)
		{
			return true;
		}
		if (!WaitFor([S] { AVibeCityDirector* D = Find<AVibeCityDirector>(); return D && D->ImportedCellMesh(S->Cell); }, 30.0))
		{
			return false;
		}
		AVibeCityDirector* D = Find<AVibeCityDirector>();
		TestTrue(TEXT("after a city reset the cell draws its imported mesh again"), D && D->ImportedCellMesh(S->Cell));
		if (D)
		{
			AddInfo(FString::Printf(TEXT("after the reset: %d of %d cells imported"), D->ImportedCellsDrawn(), D->CellCount()));
		}
		FString ShotDir;
		if (FParse::Value(FCommandLine::Get(), TEXT("VibeShotDir="), ShotDir))
		{
			FScreenshotRequest::RequestScreenshot(ShotDir / TEXT("imported.png"), false, false);
		}
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(1.0f));
	return true;
}

// VibeCity.Render.Dust: dust parcels as the core's policy makes them (dust.rs, the web's
// dustPolicy.ts), drawn without a server: one of each shape put 6 m ahead of the camera. Each is
// drawn at once, grows and rises as the web's curves say (dustParcelStore.ts evalParcel: radius
// (r0 + growth·sqrt(t))·radius0, rise·(1 - e^-0.35t)), and is gone after its shape's life (an
// entry puff's 5 s). -VibeShotDir saves dust.png.
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FVibeCityRenderDust, "VibeCity.Render.Dust",
	EAutomationTestFlags::ClientContext | EAutomationTestFlags::ProductFilter)

bool FVibeCityRenderDust::RunTest(const FString& Parameters)
{
	struct FState
	{
		double Started = 0.0;
		int32 First = INDEX_NONE;
		int32 Many = INDEX_NONE;
		TArray<FBox> AtBirth;
		/** Game time at the injection: dust ages in game time, which a slow frame clamps. */
		double BornGameS = 0.0;
	};
	TSharedRef<FState> S = MakeShared<FState>();
	// The web's shapes: (r0, growth, rise, life), dustParcelStore.ts DUST_SHAPES.
	static const double Curves[5][4] = { {1.0, 0.9, 2.0, 10}, {1.2, 1.3, 1.2, 14}, {0.8, 0.9, 2.0, 12}, {0.6, 1.1, 0.4, 5}, {1.5, 1.6, 0.8, 24} };
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S]()
	{
		AVibeCityDirector* D = Find<AVibeCityDirector>();
		UWorld* World = GameWorld();
		APlayerController* PC = World ? World->GetFirstPlayerController() : nullptr;
		if (S->Started == 0.0)
		{
			S->Started = FPlatformTime::Seconds();
		}
		if (!D || !PC || !PC->PlayerCameraManager)
		{
			if (FPlatformTime::Seconds() - S->Started > 120.0)
			{
				AddError(TEXT("no director or camera"));
				return true;
			}
			return false;
		}
		const FVector Eye = PC->PlayerCameraManager->GetCameraLocation();
		const FVector Ahead = PC->PlayerCameraManager->GetCameraRotation().Vector().GetSafeNormal2D();
		const FVector Side = FVector::CrossProduct(FVector::UpVector, Ahead);
		TArray<VlDustParcel> Parcels;
		for (uint32 Shape = 0; Shape < 5; ++Shape)
		{
			VlDustParcel P = {};
			const FVector At = Eye + Ahead * 600.0 + Side * (static_cast<double>(Shape) - 2.0) * 250.0;
			P.position[0] = At.X; P.position[1] = At.Y; P.position[2] = At.Z;
			P.radius0 = 50.0f; // cm (0.5 m)
			P.intensity = 0.9f;
			P.shape = Shape;
			P.palette = 0;
			P.color_rgba = 0xb3afa8ff;
			Parcels.Add(P);
		}
		S->First = D->InjectDustForTest(Parcels);
		S->BornGameS = World->GetTimeSeconds();
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(0.2f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S]()
	{
		AVibeCityDirector* D = Find<AVibeCityDirector>();
		if (!D || S->First == INDEX_NONE)
		{
			return true;
		}
		for (int32 k = 0; k < 5; ++k)
		{
			const TOptional<FBox> B = D->DustBox(S->First + k);
			TestTrue(*FString::Printf(TEXT("shape %d is drawn"), k), B.IsSet());
			S->AtBirth.Add(B.IsSet() ? B.GetValue() : FBox(ForceInit));
		}
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(2.0f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S]()
	{
		AVibeCityDirector* D = Find<AVibeCityDirector>();
		if (!D || S->AtBirth.Num() != 5)
		{
			return true;
		}
		for (int32 k = 0; k < 5; ++k)
		{
			const TOptional<FBox> B = D->DustBox(S->First + k);
			if (!TestTrue(*FString::Printf(TEXT("shape %d still drawn at 2 s"), k), B.IsSet()))
			{
				continue;
			}
			const double W0 = S->AtBirth[k].GetSize().X, W1 = B->GetSize().X;
			const double Rise = B->GetCenter().Z - S->AtBirth[k].GetCenter().Z;
			// Expected from the curves at the two ages (radius0 0.5 m, no push): width 2r, rise.
			AddInfo(FString::Printf(TEXT("shape %d: width %.0f -> %.0f cm, rose %.0f cm"), k, W0, W1, Rise));
			TestTrue(*FString::Printf(TEXT("shape %d grows (sqrt of age)"), k), W1 > W0 * 1.2);
			TestTrue(*FString::Printf(TEXT("shape %d rises toward its curve's height"), k), Rise > 0.0 && Rise < Curves[k][2] * 100.0);
		}
		FString ShotDir;
		if (FParse::Value(FCommandLine::Get(), TEXT("VibeShotDir="), ShotDir))
		{
			FScreenshotRequest::RequestScreenshot(ShotDir / TEXT("dust.png"), false, false);
		}
		return true;
	}));
	// An entry puff lives 5 s (of game time).
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S]()
	{
		AVibeCityDirector* D = Find<AVibeCityDirector>();
		UWorld* World = GameWorld();
		if (!D || !World || S->First == INDEX_NONE)
		{
			return true;
		}
		const double Age = World->GetTimeSeconds() - S->BornGameS;
		if (Age < 5.3 && FPlatformTime::Seconds() - S->Started < 200.0)
		{
			return false;
		}
		AddInfo(FString::Printf(TEXT("checked at a game age of %.1f s"), Age));
		TestFalse(TEXT("the entry puff is gone after its 5 s"), D->DustBox(S->First + 3).IsSet());
		TestTrue(TEXT("the wave cloud lingers (24 s)"), D->DustBox(S->First + 4).IsSet());
		return true;
	}));
	// The web's selection (DustVolumeRenderer.ts): 1500 clouds in view within 60 m draw only the
	// nearest 1024, and one behind the camera is not drawn.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S]()
	{
		AVibeCityDirector* D = Find<AVibeCityDirector>();
		APlayerController* PC = GameWorld() ? GameWorld()->GetFirstPlayerController() : nullptr;
		if (!D || !PC || !PC->PlayerCameraManager)
		{
			return true;
		}
		const FVector Eye = PC->PlayerCameraManager->GetCameraLocation();
		const FVector Ahead = PC->PlayerCameraManager->GetCameraRotation().Vector();
		TArray<VlDustParcel> Parcels;
		for (int32 k = 0; k < 1501; ++k)
		{
			VlDustParcel P = {};
			// k = 1500 behind the camera; the rest from 10 m to 55 m ahead.
			const FVector At = k == 1500 ? Eye - Ahead * 1500.0 : Eye + Ahead * (1000.0 + 3.0 * k);
			P.position[0] = At.X; P.position[1] = At.Y; P.position[2] = At.Z;
			P.radius0 = 50.0f;
			P.intensity = 0.9f;
			P.shape = 4; // the long-lived wave cloud
			P.color_rgba = 0xb3afa8ff;
			Parcels.Add(P);
		}
		S->Many = D->InjectDustForTest(Parcels);
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(0.3f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S]()
	{
		AVibeCityDirector* D = Find<AVibeCityDirector>();
		if (!D || S->Many == INDEX_NONE)
		{
			return true;
		}
		AddInfo(FString::Printf(TEXT("live %d, drawn %d"), D->LiveDust(), D->DrawnDust()));
		TestEqual(TEXT("at most the nearest 1024 are drawn"), D->DrawnDust(), 1024);
		TestTrue(TEXT("the nearest is drawn"), D->DustBox(S->Many).IsSet() && D->DustBox(S->Many)->GetSize().X > 0.0);
		TestTrue(TEXT("the farthest is not"), D->DustBox(S->Many + 1499).IsSet() && D->DustBox(S->Many + 1499)->GetSize().X == 0.0);
		TestTrue(TEXT("the one behind the camera is not"), D->DustBox(S->Many + 1500).IsSet() && D->DustBox(S->Many + 1500)->GetSize().X == 0.0);
		return true;
	}));
	// A heavy chunk landing on the ground (an impact puff at ground level, radius over 40 cm) leaves a
	// dust mark; a light one, or one high up, does not.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this]()
	{
		AVibeCityDirector* D = Find<AVibeCityDirector>();
		if (!D)
		{
			return true;
		}
		const int64 Before = D->DustMarks();
		auto Impact = [](float Z, float RadiusCm) {
			VlDustParcel P = {};
			P.position[0] = 0.0f; P.position[1] = 0.0f; P.position[2] = Z;
			P.radius0 = RadiusCm;
			P.intensity = 0.8f;
			P.shape = 1; // VL_DUST_IMPACT
			P.color_rgba = 0xb3afa8ff;
			return P;
		};
		const VlDustParcel Parcels[] = { Impact(50.0f, 70.0f), Impact(50.0f, 20.0f), Impact(900.0f, 70.0f) };
		D->InjectDustForTest(Parcels);
		TestEqual(TEXT("only the heavy chunk on the ground marked it"), D->DustMarks() - Before, (int64)1);
		// Settled dust, not paint: darker than mid grey and under half strength.
		const TPair<FLinearColor, float> Look = D->DustMarkLook();
		AddInfo(FString::Printf(TEXT("dust mark: colour %s, strength %.2f"), *Look.Key.ToString(), Look.Value));
		TestTrue(TEXT("the mark is an earth tone darker than mid grey"), Look.Key.GetLuminance() < 0.3f && Look.Key.R >= Look.Key.B);
		TestTrue(TEXT("the mark is under half strength"), Look.Value > 0.0f && Look.Value < 0.5f);
		TestTrue(TEXT("a new mark starts faint (the dust has not settled yet)"), D->NewestDustMarkStrength() < 0.1f * Look.Value);
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(2.0f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this]()
	{
		const AVibeCityDirector* D = Find<AVibeCityDirector>();
		const float Mid = D ? D->NewestDustMarkStrength() : -1.0f;
		AddInfo(FString::Printf(TEXT("dust mark after 2 s: strength %.2f"), Mid));
		TestTrue(TEXT("after 2 s the mark is building up, not yet full"), D && Mid > 0.0f && Mid < D->DustMarkLook().Value * 0.9f);
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(5.0f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this]()
	{
		const AVibeCityDirector* D = Find<AVibeCityDirector>();
		TestTrue(TEXT("after the dust settles (6 s) the mark is at full strength"), D && FMath::IsNearlyEqual(D->NewestDustMarkStrength(), D->DustMarkLook().Value, 0.01f));
		return true;
	}));
	return true;
}

// VibeCity.Perf.Meteor: the game thread's cost of destruction (the plan's M4 measurement). After
// the city settles, a meteor lands on the highest chunk within 60 m of the camera; 8 s of frames
// are recorded: frame time, the core's poll, applying the frame (body poses, cell rebuilds), dust.
// Reports percentiles and peaks, and the plan's GPU-path rule (more than 4 ms applying poses at
// 4000 live bodies). -VibeShotDir saves perf.png mid-collapse.
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FVibeCityPerfMeteor, "VibeCity.Perf.Meteor",
	EAutomationTestFlags::ClientContext | EAutomationTestFlags::ProductFilter)

bool FVibeCityPerfMeteor::RunTest(const FString& Parameters)
{
	struct FState
	{
		double Started = 0.0;
		double MeteorAt = 0.0;
	};
	TSharedRef<FState> S = MakeShared<FState>();
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S]()
	{
		AVibeCityDirector* D = Find<AVibeCityDirector>();
		if (S->Started == 0.0)
		{
			S->Started = FPlatformTime::Seconds();
		}
		if (!D || !D->IsCityBuilt())
		{
			if (FPlatformTime::Seconds() - S->Started > 240.0)
			{
				AddError(TEXT("the city was not built"));
				return true;
			}
			return false;
		}
		// Settle (a big city sheds what its first ticks break).
		return FPlatformTime::Seconds() - S->Started > 20.0;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S]()
	{
		AVibeCityDirector* D = Find<AVibeCityDirector>();
		UVibeNetSubsystem* N = Net();
		UWorld* World = GameWorld();
		APlayerController* PC = World ? World->GetFirstPlayerController() : nullptr;
		if (!D || !N || !PC || !PC->PlayerCameraManager)
		{
			AddError(TEXT("no director, net or camera"));
			return true;
		}
		const FVector Eye = PC->PlayerCameraManager->GetCameraLocation();
		const TArrayView<const VlChunk> Chunks = N->Chunks();
		FVector Target(0.0, 0.0, -1.0e9);
		for (const VlChunk& C : Chunks)
		{
			const FVector P = VibeCityCells::RestTransform(C).GetLocation();
			if (FVector::Dist2D(P, Eye) < 6000.0 && P.Z > Target.Z)
			{
				Target = P;
			}
		}
		if (Target.Z < -1.0e8)
		{
			AddError(TEXT("no chunk within 60 m of the camera"));
			return true;
		}
		D->ClearPerfHistory();
		Post(N->CurrentApiBaseUrl() / TEXT("city-meteor") / N->CurrentMatchId(),
			FString::Printf(TEXT("{\"targets\":[[%f,%f,%f]]}"), -Target.Y / 100.0, Target.Z / 100.0, Target.X / 100.0));
		S->MeteorAt = FPlatformTime::Seconds();
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(5.0f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([]()
	{
		FString ShotDir;
		if (FParse::Value(FCommandLine::Get(), TEXT("VibeShotDir="), ShotDir))
		{
			FScreenshotRequest::RequestScreenshot(ShotDir / TEXT("perf.png"), false, false);
		}
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(3.0f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S]()
	{
		AVibeCityDirector* D = Find<AVibeCityDirector>();
		if (!D)
		{
			return true;
		}
		TArray<AVibeCityDirector::FPerfSample> Samples = D->PerfHistory();
		if (!TestTrue(TEXT("frames recorded"), Samples.Num() > 10))
		{
			return true;
		}
		auto Stat = [&Samples](float AVibeCityDirector::FPerfSample::*Field, double Q)
		{
			TArray<float> V;
			for (const AVibeCityDirector::FPerfSample& X : Samples)
			{
				V.Add(X.*Field);
			}
			V.Sort();
			return V[FMath::Clamp(static_cast<int32>(Q * (V.Num() - 1)), 0, V.Num() - 1)];
		};
		int32 PeakBodies = 0, PeakPoses = 0, PeakDust = 0;
		float ApplyAtPeak = 0.0f;
		for (const AVibeCityDirector::FPerfSample& X : Samples)
		{
			PeakPoses = FMath::Max(PeakPoses, X.PosesApplied);
			PeakDust = FMath::Max(PeakDust, X.LiveDust);
			if (X.LiveBodies >= PeakBodies)
			{
				PeakBodies = X.LiveBodies;
				ApplyAtPeak = FMath::Max(ApplyAtPeak, X.ApplyMs);
			}
		}
		using FS = AVibeCityDirector::FPerfSample;
		AddInfo(FString::Printf(TEXT("%d chunks, %d frames over 8 s after the meteor"), Net() ? Net()->Chunks().Num() : 0, Samples.Num()));
		AddInfo(FString::Printf(TEXT("frame ms p50 %.1f p95 %.1f max %.1f"), Stat(&FS::FrameMs, 0.5), Stat(&FS::FrameMs, 0.95), Stat(&FS::FrameMs, 1.0)));
		AddInfo(FString::Printf(TEXT("poll ms p50 %.2f p95 %.2f max %.2f"), Stat(&FS::PollMs, 0.5), Stat(&FS::PollMs, 0.95), Stat(&FS::PollMs, 1.0)));
		AddInfo(FString::Printf(TEXT("apply ms p50 %.2f p95 %.2f max %.2f"), Stat(&FS::ApplyMs, 0.5), Stat(&FS::ApplyMs, 0.95), Stat(&FS::ApplyMs, 1.0)));
		AddInfo(FString::Printf(TEXT("dust ms p50 %.2f p95 %.2f max %.2f"), Stat(&FS::DustMs, 0.5), Stat(&FS::DustMs, 0.95), Stat(&FS::DustMs, 1.0)));
		AddInfo(FString::Printf(TEXT("peak: %d live bodies, %d poses in a frame, %d dust parcels; apply at peak bodies %.2f ms"), PeakBodies, PeakPoses, PeakDust, ApplyAtPeak));
		const bool bGpuPath = PeakBodies >= 4000 ? ApplyAtPeak > 4.0f : false;
		AddInfo(FString::Printf(TEXT("GPU pose path rule (> 4 ms at 4000 live bodies): %s"),
			PeakBodies >= 4000 ? (bGpuPath ? TEXT("tripped") : TEXT("not tripped")) : TEXT("not reached (fewer than 4000 live bodies)")));
		TestTrue(TEXT("the meteor freed bodies"), PeakBodies > 0);
		return true;
	}));
	return true;
}

// VibeCity.Render.Showcase: one scripted shot for judging the look, before and after a change. The
// camera parks at (-18, 5, -16) looking at the building at (-42, 4, -42) (server metres); the player
// stands beside it; a meteor is sent at the building's top at 1 s and the cannon fires at it at
// 1.5 s (a server sharing the GPU flies them slower than real time). The HUD is hidden; frames
// every 0.5 s for 20 s go to -VibeShotDir as showcase_NN.png.
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FVibeCityRenderShowcase, "VibeCity.Render.Showcase",
	EAutomationTestFlags::ClientContext | EAutomationTestFlags::ProductFilter)

bool FVibeCityRenderShowcase::RunTest(const FString& Parameters)
{
	struct FState
	{
		double Started = 0.0;
		double T0 = 0.0;
		int32 Shots = 0;
		bool bCannon = false;
		bool bMeteor = false;
		FVector Target = FVector::ZeroVector;
	};
	TSharedRef<FState> S = MakeShared<FState>();
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S]()
	{
		AVibeCityDirector* D = Find<AVibeCityDirector>();
		UVibeNetSubsystem* N = Net();
		if (S->Started == 0.0)
		{
			S->Started = FPlatformTime::Seconds();
		}
		if (!D || !D->IsCityBuilt() || !N || !(N->LastFrame().local.player.flags & VL_PLAYER_VALID))
		{
			if (FPlatformTime::Seconds() - S->Started > 120.0)
			{
				AddError(TEXT("not ready"));
				return true;
			}
			return false;
		}
		// Let the meadow and the materials settle.
		if (FPlatformTime::Seconds() - S->Started < 8.0)
		{
			return false;
		}
		// The shot (server metres: eye, target, fov), -VibeShowcase=px,py,pz,tx,ty,tz,fov for another
		// scene; by default about 55 m back from the default city's corner building, far enough that
		// a meteor's blast does not bury the camera in debris. The player stands below the camera,
		// facing the target; the meteor falls on the highest chunk within 15 m of the target.
		FString Shot = TEXT("-4,9,-2,-42,4,-42,60");
		FParse::Value(FCommandLine::Get(), TEXT("VibeShowcase="), Shot, /*bShouldStopOnSeparator=*/false);
		FVector3f Eye, Look;
		float Fov = 60.0f;
		if (!VibeCityCapture::Parse(Shot, Eye, Look, Fov))
		{
			AddError(FString::Printf(TEXT("bad -VibeShowcase=%s"), *Shot));
			return true;
		}
		const FVector From(100.0 * Eye.Z, -100.0 * Eye.X, 100.0);
		S->Target = FVector(100.0 * Look.Z, -100.0 * Look.X, 100.0 * Look.Y);
		N->CameraDrop(From, static_cast<float>((S->Target - From).Rotation().Yaw), 0.0f);
		VibeCityCapture::Park(GameWorld(), Eye, Look, Fov > 0.0f ? Fov : 60.0f);
		if (APlayerController* PC = GameWorld()->GetFirstPlayerController(); PC && PC->GetHUD())
		{
			PC->GetHUD()->bShowHUD = false;
		}
		GEngine->bEnableOnScreenDebugMessages = false;
		S->T0 = FPlatformTime::Seconds();
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S]()
	{
		const double T = FPlatformTime::Seconds() - S->T0;
		UVibeNetSubsystem* N = Net();
		if (N && !S->bCannon && T > 1.5)
		{
			S->bCannon = true;
			N->Fire(VL_WEAPON_CANNON);
		}
		if (N && !S->bMeteor && T > 1.0)
		{
			S->bMeteor = true;
			// The building's highest chunk.
			FVector Top(0.0, 0.0, -1.0e9);
			for (const VlChunk& C : N->Chunks())
			{
				const FVector P = VibeCityCells::RestTransform(C).GetLocation();
				if (FVector::Dist2D(P, S->Target) < 1500.0 && P.Z > Top.Z)
				{
					Top = P;
				}
			}
			Post(N->CurrentApiBaseUrl() / TEXT("city-meteor") / N->CurrentMatchId(),
				FString::Printf(TEXT("{\"targets\":[[%f,%f,%f]]}"), -Top.Y / 100.0, Top.Z / 100.0, Top.X / 100.0));
		}
		FString ShotDir;
		if (FParse::Value(FCommandLine::Get(), TEXT("VibeShotDir="), ShotDir) && T >= 0.5 * S->Shots)
		{
			FScreenshotRequest::RequestScreenshot(ShotDir / FString::Printf(TEXT("showcase_%02d.png"), S->Shots), false, false);
			++S->Shots;
		}
		return T > 20.0;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S]()
	{
		VibeCityCapture::Park(GameWorld(), FVector3f::ZeroVector, FVector3f::ZeroVector, 0.0f);
		AddInfo(FString::Printf(TEXT("showcase: %d frames"), S->Shots));
		TestTrue(TEXT("frames saved (with -VibeShotDir)"), S->Shots > 0 || !FParse::Param(FCommandLine::Get(), TEXT("VibeShotDir")));
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(0.5f));
	return true;
}

// VibeCity.Render.ProjectileLook: a still of the meteor material (hot, and cooling) and the iron
// cannonball, 10 m from a parked camera against the sky, to judge their surfaces (frames go to
// -VibeShotDir as projectiles.png).
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FVibeCityRenderProjectileLook, "VibeCity.Render.ProjectileLook",
	EAutomationTestFlags::ClientContext | EAutomationTestFlags::ProductFilter)

bool FVibeCityRenderProjectileLook::RunTest(const FString& Parameters)
{
	TSharedRef<double> Started = MakeShared<double>(FPlatformTime::Seconds());
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Started]()
	{
		AVibeCityDirector* D = Find<AVibeCityDirector>();
		if (!D || !D->IsCityBuilt())
		{
			return FPlatformTime::Seconds() - *Started > 120.0;
		}
		UWorld* World = GameWorld();
		UStaticMesh* Sphere = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Sphere.Sphere"));
		UMaterialInterface* Meteor = LoadObject<UMaterialInterface>(nullptr, TEXT("/Game/VibeCity/Materials/M_VibeCityMeteor.M_VibeCityMeteor"));
		UMaterialInterface* Iron = LoadObject<UMaterialInterface>(nullptr, TEXT("/Game/VibeCity/Materials/M_VibeCityCannonball.M_VibeCityCannonball"));
		if (!TestTrue(TEXT("meshes and materials load"), Sphere && Meteor && Iron))
		{
			return true;
		}
		AActor* Holder = World->SpawnActor<AActor>();
		Holder->SetRootComponent(NewObject<USceneComponent>(Holder));
		Holder->GetRootComponent()->RegisterComponent();
		// Server (0, 30, 130) and on: 10 m ahead of the camera at server (0, 30, 140).
		auto Add = [&](UMaterialInterface* M, float Glow, const FVector& Server, double DiameterM)
		{
			UStaticMeshComponent* C = NewObject<UStaticMeshComponent>(Holder);
			C->SetStaticMesh(Sphere);
			UMaterialInstanceDynamic* Mid = UMaterialInstanceDynamic::Create(M, Holder);
			Mid->SetScalarParameterValue(TEXT("Glow"), Glow);
			C->SetMaterial(0, Mid);
			C->SetupAttachment(Holder->GetRootComponent());
			C->RegisterComponent();
			C->SetWorldLocation(FVector(100.0 * Server.Z, -100.0 * Server.X, 100.0 * Server.Y));
			C->SetWorldScale3D(FVector(DiameterM));
		};
		Add(Meteor, 1.0f, FVector(-2.2, 30.0, 130.0), 3.0);
		// Its flames, flying to the left (server -x): the shell 1.45x across, 3x along, front at the rock.
		if (UMaterialInterface* Fire = LoadObject<UMaterialInterface>(nullptr, TEXT("/Game/VibeCity/Materials/M_VibeCityMeteorFire.M_VibeCityMeteorFire")))
		{
			UStaticMeshComponent* C = NewObject<UStaticMeshComponent>(Holder);
			C->SetStaticMesh(Sphere);
			C->SetMaterial(0, Fire);
			C->SetCastShadow(false);
			C->SetupAttachment(Holder->GetRootComponent());
			C->RegisterComponent();
			const FVector Dir(0.0, 1.0, 0.0); // server -x in Unreal axes
			const double R = 150.0;
			C->SetWorldLocationAndRotation(FVector(13000.0, 220.0, 3000.0) - Dir * R * 1.8, FRotationMatrix::MakeFromZ(Dir).ToQuat());
			C->SetWorldScale3D(FVector(2.9 * R, 2.9 * R, 6.0 * R) / 100.0);
		}
		Add(Meteor, 0.15f, FVector(1.8, 30.0, 130.0), 3.0);
		Add(Iron, 1.0f, FVector(0.0, 28.4, 133.0), 0.6);
		VibeCityCapture::Park(World, FVector3f(0.0f, 30.0f, 140.0f), FVector3f(0.0f, 30.0f, 130.0f), 40.0f);
		if (APlayerController* PC = World->GetFirstPlayerController(); PC && PC->GetHUD())
		{
			PC->GetHUD()->bShowHUD = false;
		}
		*Started = FPlatformTime::Seconds();
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(8.0f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this]()
	{
		FString ShotDir;
		if (FParse::Value(FCommandLine::Get(), TEXT("VibeShotDir="), ShotDir))
		{
			FScreenshotRequest::RequestScreenshot(ShotDir / TEXT("projectiles.png"), false, false);
		}
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(1.0f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this]()
	{
		VibeCityCapture::Park(GameWorld(), FVector3f::ZeroVector, FVector3f::ZeroVector, 0.0f);
		return true;
	}));
	return true;
}

#endif
