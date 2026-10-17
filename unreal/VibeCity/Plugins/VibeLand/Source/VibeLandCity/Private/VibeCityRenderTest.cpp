// VibeCity.Render.CityAndEffects: the city renderer against a live PhysX server.
//
//  * every chunk is drawn: the vertices in standing cells plus on bodies equal the core's chunk
//    meshes' vertices less the removed chunks', before and after a fracture;
//  * chunks wear the generated catalog material (not the fallback);
//  * the meadow has patches drawn around the camera;
//  * a meteor's fractures reach the frame as sounds and dust, and dust puffs appear.
//
// Run in the game on a citypp match (scripts/unreal/play-tests.sh --only VibeCity.Render.CityAndEffects).

#include "EngineUtils.h"
#include "Engine/Engine.h"
#include "Engine/GameInstance.h"
#include "Engine/World.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Misc/AutomationTest.h"
#include "Tests/AutomationCommon.h"
#include "VibeCityDirector.h"
#include "VibeCityGrass.h"
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
		const FString Body = FString::Printf(TEXT("{\"targets\":[[%f,%f,%f]]}"), -Top->rest_pos[1] / 100.0, Top->rest_pos[2] / 100.0, Top->rest_pos[0] / 100.0);
		Post(N->CurrentApiBaseUrl() / TEXT("city-meteor") / N->CurrentMatchId(), Body);
		State->SoundsAtMeteor = Director->SoundsSeen();
		State->DustAtMeteor = Director->DustSeen();
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
		AddInfo(FString::Printf(TEXT("after the meteor: %llu fractures, %lld sounds, %lld dust (peak %d live), %lld body vertices"),
			Fractures, Director->SoundsSeen() - State->SoundsAtMeteor, Director->DustSeen() - State->DustAtMeteor, State->PeakDust, Director->DrawnBodyVertices()));
		return true;
	}));
	return true;
}

#endif
