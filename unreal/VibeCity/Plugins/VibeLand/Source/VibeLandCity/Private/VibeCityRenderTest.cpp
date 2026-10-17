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
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Misc/AutomationTest.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Tests/AutomationCommon.h"
#include "UObject/UObjectIterator.h"
#include "UnrealClient.h"
#include "Engine/StaticMesh.h"
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
		FParse::Value(FCommandLine::Get(), TEXT("VibeCapture="), Text);
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

#endif
