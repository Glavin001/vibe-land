// VibeCity.Render.Ragdoll: a player who dies standing on flat ground falls as the web's cosmetic
// ragdoll and comes to rest lying down.
//
// Lying, a body's pelvis is about its own half-thickness over the ground (the rig's pelvis box is
// 0.22 m deep at 1.67 m, so ~0.11 m); standing it is 0.95 m. The gate is the midpoint of those
// two, half the standing height, and it must hold over the last second. The ground the ragdoll lands
// on is the city ground (z 0). Whether the solver has put it to sleep is reported, not gated.

#include "Engine/Engine.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "GameFramework/PlayerController.h"
#include "Misc/AutomationTest.h"
#include "Tests/AutomationCommon.h"
#include "UnrealClient.h"
#include "VibeRemotePlayers.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace
{
	UWorld* RagdollTestWorld()
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

	AVibeRemotePlayers* PlayersOf(UWorld* World)
	{
		TActorIterator<AVibeRemotePlayers> It(World);
		return It ? *It : nullptr;
	}

	constexpr double StandingPelvisCm = 95.0;
	constexpr double SettleS = 6.0;
	constexpr double HoldS = 1.0;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FVibeCityRenderRagdoll, "VibeCity.Render.Ragdoll",
	EAutomationTestFlags::ClientContext | EAutomationTestFlags::ProductFilter)

bool FVibeCityRenderRagdoll::RunTest(const FString& Parameters)
{
	struct FState
	{
		uint32 Id = 0;
		double Start = 0.0;
		double LowestZ = TNumericLimits<double>::Max();
		double HighestLateZ = -TNumericLimits<double>::Max();
		double LastZ = 0.0;
		int32 Samples = 0;
		FString Trace;
		bool bAtRest = false;
	};
	TSharedRef<FState> S = MakeShared<FState>();
	// Once the mannequin is in, a player dies standing 4 m ahead of the camera.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S]()
	{
		UWorld* World = RagdollTestWorld();
		AVibeRemotePlayers* Players = PlayersOf(World);
		APlayerController* PC = World ? World->GetFirstPlayerController() : nullptr;
		if (!Players || !PC || !PC->PlayerCameraManager || !Players->UsesMannequin())
		{
			if (S->Start == 0.0)
			{
				S->Start = FPlatformTime::Seconds();
			}
			if (FPlatformTime::Seconds() - S->Start > 90.0)
			{
				AddError(TEXT("no mannequin to ragdoll"));
				return true;
			}
			return false;
		}
		const FVector Eye = PC->PlayerCameraManager->GetCameraLocation();
		const FVector Ahead = PC->PlayerCameraManager->GetCameraRotation().Vector().GetSafeNormal2D();
		const FVector At = FVector(Eye.X, Eye.Y, 0.0) + Ahead * 400.0 + FVector(0.0, 0.0, 80.0);
		S->Id = Players->DropTestRagdoll(At, FVector::ZeroVector);

		S->Start = FPlatformTime::Seconds();
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([S]()
	{
		AVibeRemotePlayers* Players = PlayersOf(RagdollTestWorld());
		const double T = FPlatformTime::Seconds() - S->Start;
		if (Players)
		{
			if (const TOptional<FVector> Pelvis = Players->RagdollPelvis(S->Id))
			{
				S->LowestZ = FMath::Min(S->LowestZ, Pelvis->Z);
				S->LastZ = Pelvis->Z;
				if (T > SettleS - HoldS)
				{
					S->HighestLateZ = FMath::Max(S->HighestLateZ, Pelvis->Z);
				}
				if (S->Samples++ % 30 == 0)
				{
					S->Trace += FString::Printf(TEXT(" %.0f"), Pelvis->Z);
				}
			}
			S->bAtRest = Players->RagdollAtRest(S->Id);

		}
		return T > SettleS;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S]()
	{
		AddInfo(FString::Printf(TEXT("pelvis every 30 frames (cm):%s; lowest %.1f, highest in the last %.0f s %.1f, last %.1f; at rest %d"),
			*S->Trace, S->LowestZ, HoldS, S->HighestLateZ, S->LastZ, S->bAtRest ? 1 : 0));
		TestTrue(TEXT("the ragdoll was simulated"), S->Samples > 0);
		TestTrue(TEXT("it lies down: the pelvis under half its standing height for the last second"), S->Samples > 0 && S->HighestLateZ < StandingPelvisCm * 0.5);
		TestTrue(TEXT("the ground holds it"), S->Samples > 0 && S->LowestZ >= 0.0);
		FString ShotDir;
		if (FParse::Value(FCommandLine::Get(), TEXT("VibeShotDir="), ShotDir))
		{
			FScreenshotRequest::RequestScreenshot(ShotDir / TEXT("ragdoll.png"), false, false);
		}
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(1.0f));
	return true;
}

#endif
