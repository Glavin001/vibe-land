// VibeCity.Play.Hud: the web's controls panel and shared-grass status line (App.tsx).
//
// Once joined, the HUD draws the controls panel expanded (ControlHintsOverlay.tsx) with every
// on-foot command for keyboard and mouse, folds it on F1 (ToggleControls) and unfolds it again;
// and shows the shared grass layout's status (GrassLayoutSync.ts): "Shared grass · <revision>" with
// the first 8 characters of the revision the grass actor loaded. -VibeShotDir=<dir> saves hud.png
// (with the HUD drawn).

#include "Engine/Engine.h"
#include "Engine/GameInstance.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "GameFramework/PlayerController.h"
#include "Misc/AutomationTest.h"
#include "Misc/Paths.h"
#include "Tests/AutomationCommon.h"
#include "UnrealClient.h"
#include "VibeCityGrass.h"
#include "VibeCityHUD.h"
#include "VibeNetSubsystem.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace
{
	UWorld* HudTestWorld()
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

	AVibeCityHUD* HudOf(UWorld* World)
	{
		APlayerController* PC = World ? World->GetFirstPlayerController() : nullptr;
		return PC ? Cast<AVibeCityHUD>(PC->GetHUD()) : nullptr;
	}

	AVibeCityGrass* GrassOf(UWorld* World)
	{
		TActorIterator<AVibeCityGrass> It(World);
		return It ? *It : nullptr;
	}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FVibeCityPlayHud, "VibeCity.Play.Hud",
	EAutomationTestFlags::ClientContext | EAutomationTestFlags::ProductFilter)

bool FVibeCityPlayHud::RunTest(const FString& Parameters)
{
	struct FState
	{
		double Deadline = 0.0;
	};
	TSharedRef<FState> S = MakeShared<FState>();
	// Joined, the panel drawn, and the grass layout answered.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S]()
	{
		UWorld* World = HudTestWorld();
		AVibeCityHUD* Hud = HudOf(World);
		AVibeCityGrass* Grass = GrassOf(World);
		if (S->Deadline == 0.0)
		{
			S->Deadline = FPlatformTime::Seconds() + 90.0;
		}
		const bool bReady = Hud && Grass && Hud->ControlRows() > 0 && Hud->GrassSyncShown().StartsWith(TEXT("Shared grass ·"));
		if (!bReady && FPlatformTime::Seconds() < S->Deadline)
		{
			return false;
		}
		if (!Hud || !Grass)
		{
			AddError(TEXT("no HUD or grass actor"));
			return true;
		}
		AddInfo(FString::Printf(TEXT("controls: %d rows, \"%s\"; grass: \"%s\""), Hud->ControlRows(), *Hud->ControlsTitle(), *Hud->GrassSyncShown()));
		TestEqual(TEXT("every on-foot command for keyboard and mouse (12 rows)"), Hud->ControlRows(), 12);
		TestEqual(TEXT("the panel's title"), Hud->ControlsTitle(), FString(TEXT("Keyboard + Mouse · On Foot")));
		TestEqual(TEXT("the shared grass line names the loaded revision"), Hud->GrassSyncShown(),
			FString::Printf(TEXT("Shared grass · %s"), *Grass->PaintRevision().Left(8)));
		TestFalse(TEXT("a revision was loaded"), Grass->PaintRevision().IsEmpty());
		Hud->ToggleControls();
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(0.5f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this]()
	{
		AVibeCityHUD* Hud = HudOf(HudTestWorld());
		TestEqual(TEXT("folded, the panel draws no rows"), Hud ? Hud->ControlRows() : -1, 0);
		if (Hud)
		{
			Hud->ToggleControls();
		}
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(0.5f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this]()
	{
		AVibeCityHUD* Hud = HudOf(HudTestWorld());
		TestEqual(TEXT("unfolded again"), Hud ? Hud->ControlRows() : -1, 12);
		FString ShotDir;
		if (FParse::Value(FCommandLine::Get(), TEXT("VibeShotDir="), ShotDir))
		{
			FScreenshotRequest::RequestScreenshot(ShotDir / TEXT("hud.png"), true, false);
		}
		// The city stats (F9): closed at first, then the server's match stats and the client's
		// counters.
		TestEqual(TEXT("the stats start closed"), Hud ? Hud->StatsOpen() : true, false);
		if (Hud)
		{
			Hud->ToggleStats();
		}
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(2.5f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this]()
	{
		AVibeCityHUD* Hud = HudOf(HudTestWorld());
		AddInfo(FString::Printf(TEXT("stats: %d server rows, %d client rows"), Hud ? Hud->StatsServerRows() : -1, Hud ? Hud->StatsClientRows() : -1));
		TestTrue(TEXT("the server's match stats arrived"), Hud && Hud->StatsServerRows() >= 5);
		TestEqual(TEXT("the client's counters"), Hud ? Hud->StatsClientRows() : -1, 9);
		FString ShotDir;
		if (FParse::Value(FCommandLine::Get(), TEXT("VibeShotDir="), ShotDir))
		{
			FScreenshotRequest::RequestScreenshot(ShotDir / TEXT("stats.png"), true, false);
		}
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(1.0f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this]()
	{
		if (AVibeCityHUD* Hud = HudOf(HudTestWorld()))
		{
			Hud->ToggleStats();
			TestFalse(TEXT("closed again"), Hud->StatsOpen());
		}
		return true;
	}));
	return true;
}

#endif
