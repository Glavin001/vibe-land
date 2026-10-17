// VibeCity.Play.WalkAndShoot: M2's gate in the real game against a live vibe-land server. Input goes
// in through Slate's platform-input entry points (as real keys and clicks do), so the whole route is
// exercised: Enhanced Input -> AVibePlayerPawn -> the shared core's 60 Hz input frames -> the server's
// PhysX character controller -> snapshots -> the presented pose.
//
// Gates, from the server's own numbers:
//   * holding W walks the player at the server's walk speed (MoveConfig::walk_speed, 6 m/s) +-5%
//     toward the view's yaw (+-2 degrees): the server's reported velocity, and the distance covered
//     per input frame the server applied (ack seq). The server applies input frames in real time
//     (several per tick when its ticks run slow, server/src/main.rs), so neither wall time nor
//     server ticks measure movement: applied 60 Hz frames do. The walk heads away from the city,
//     over open ground, so nothing it bumps into slows it;
//   * a click fires: the core reports the local shot, and the server answers it (ShotResult).
//
// Needs a server with a citypp match (scripts/perf/garage-vehicle-server.sh, or the synthetic one):
//   UnrealEditor VibeCity.uproject -game -windowed -VibeMatch=citypp-m2 \
//     -ExecCmds="Automation RunTests VibeCity.Play; Quit"

#include "Engine/Engine.h"
#include "Engine/GameInstance.h"
#include "Engine/GameViewportClient.h"
#include "Engine/World.h"
#include "Framework/Application/SlateApplication.h"
#include "GameFramework/PlayerController.h"
#include "InputCoreTypes.h"
#include "Kismet/GameplayStatics.h"
#include "Misc/AutomationTest.h"
#include "Tests/AutomationCommon.h"
#include "VibeNetSubsystem.h"
#include "VibePlayerPawn.h"
#include "VibeShotEffects.h"
#include "EngineUtils.h"
#include "Widgets/SViewport.h"
#include "Widgets/SWindow.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace
{
	UWorld* GameWorld()
	{
		for (const FWorldContext& Context : GEngine->GetWorldContexts())
		{
			if ((Context.WorldType == EWorldType::Game || Context.WorldType == EWorldType::PIE) && Context.World())
			{
				return Context.World();
			}
		}
		return nullptr;
	}

	UVibeNetSubsystem* NetOf(UWorld* World)
	{
		UGameInstance* GameInstance = World ? World->GetGameInstance() : nullptr;
		return GameInstance ? GameInstance->GetSubsystem<UVibeNetSubsystem>() : nullptr;
	}

	void Key(const FKey& Key, bool bDown)
	{
		FSlateApplication& Slate = FSlateApplication::Get();
		const FKeyEvent Event(Key, FModifierKeysState(), Slate.GetUserIndexForKeyboard(), false, 0, 0);
		if (bDown)
		{
			Slate.ProcessKeyDownEvent(Event);
		}
		else
		{
			Slate.ProcessKeyUpEvent(Event);
		}
	}

	void Click()
	{
		UGameViewportClient* Viewport = GEngine->GameViewport;
		TSharedPtr<SViewport> Widget = Viewport ? Viewport->GetGameViewportWidget() : nullptr;
		TSharedPtr<SWindow> Window = Viewport ? Viewport->GetWindow() : nullptr;
		if (!Widget || !Window)
		{
			return;
		}
		const FVector2D Centre = Widget->GetTickSpaceGeometry().GetAbsolutePositionAtCoordinates(FVector2D(0.5, 0.5));
		FSlateApplication& Slate = FSlateApplication::Get();
		Slate.ProcessMouseButtonDownEvent(Window->GetNativeWindow(), FPointerEvent(Slate.GetUserIndexForMouse(), FSlateApplication::CursorPointerIndex,
			Centre, Centre, TSet<FKey>({ EKeys::LeftMouseButton }), EKeys::LeftMouseButton, 0.0f, FModifierKeysState()));
		Slate.ProcessMouseButtonUpEvent(FPointerEvent(Slate.GetUserIndexForMouse(), FSlateApplication::CursorPointerIndex,
			Centre, Centre, TSet<FKey>(), EKeys::LeftMouseButton, 0.0f, FModifierKeysState()));
	}

	/** What the test needs from the frames, collected as they arrive. */
	struct FPlayState
	{
		VlLocal Local = {};
		float RenderTick = 0.0f;
		uint32 PlayerId = 0;
		TArray<VlEvent> Events;
		FDelegateHandle Handle;
		FVector WalkStart = FVector::ZeroVector;
		uint32 WalkStartAck = 0;
		float Yaw = 0.0f;
		float MaxVelocityError = 0.0f;
		int32 VelocitySamples = 0;
		double Deadline = 0.0;
		uint32 ShotId = 0;
		int32 MaxTracers = 0;
	};

	double Now()
	{
		return FPlatformTime::Seconds();
	}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FVibeCityPlayWalkAndShoot, "VibeCity.Play.WalkAndShoot",
	EAutomationTestFlags::ClientContext | EAutomationTestFlags::ProductFilter)

bool FVibeCityPlayWalkAndShoot::RunTest(const FString& Parameters)
{
	TSharedRef<FPlayState> S = MakeShared<FPlayState>();
	const float WalkSpeedMps = 6.0f; // vibe_netcode::movement::MoveConfig::default().walk_speed

	// Join: the server has placed this player.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S]()
	{
		UWorld* World = GameWorld();
		UVibeNetSubsystem* Net = NetOf(World);
		if (!Net)
		{
			return false;
		}
		if (!S->Handle.IsValid())
		{
			S->Deadline = Now() + 90.0;
			S->Handle = Net->OnFrame.AddLambda([S](const VlFrameView& Frame)
			{
				S->Local = Frame.local;
				S->RenderTick = Frame.stats.player_render_tick;
				S->PlayerId = Frame.stats.player_id;
				for (size_t i = 0; i < Frame.event_count; ++i)
				{
					S->Events.Add(Frame.events[i]);
				}
			});
		}
		const AVibePlayerPawn* Pawn = Cast<AVibePlayerPawn>(UGameplayStatics::GetPlayerPawn(World, 0));
		if (Pawn && Pawn->IsJoined())
		{
			return true;
		}
		if (Now() > S->Deadline)
		{
			AddError(TEXT("never joined (is a server running with a citypp match?)"));
			return true;
		}
		return false;
	}));
	// Settle on the ground, face a known way, capture the mouse.
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(2.0f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([S]()
	{
		Click();
		// Away from the city's centre (the origin): open ground.
		S->Yaw = FMath::RadiansToDegrees(FMath::Atan2(S->Local.player.pos[1], S->Local.player.pos[0]));
		if (APlayerController* PC = UGameplayStatics::GetPlayerController(GameWorld(), 0))
		{
			PC->SetControlRotation(FRotator(0.0f, S->Yaw, 0.0f));
		}
		Key(EKeys::W, true);
		return true;
	}));
	// Up to speed (ground acceleration 80 m/s^2) and the presentation lead steady.
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(1.0f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([S]()
	{
		S->WalkStart = FVector(S->Local.player.pos[0], S->Local.player.pos[1], S->Local.player.pos[2]);
		S->WalkStartAck = S->Local.ack_input_seq;
		S->Deadline = Now() + 3.0;
		return true;
	}));
	// While walking: the server's own velocity for the player, every frame.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([S, WalkSpeedMps]()
	{
		const FVector V(S->Local.player.vel[0], S->Local.player.vel[1], 0.0);
		S->MaxVelocityError = FMath::Max(S->MaxVelocityError, FMath::Abs(static_cast<float>(V.Size()) / 100.0f - WalkSpeedMps));
		S->VelocitySamples += 1;
		return Now() > S->Deadline;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S, WalkSpeedMps]()
	{
		Key(EKeys::W, false);
		const FVector End(S->Local.player.pos[0], S->Local.player.pos[1], S->Local.player.pos[2]);
		const uint32 Frames = (S->Local.ack_input_seq - S->WalkStartAck) & 0xFFFF;
		const FVector Horizontal(End.X - S->WalkStart.X, End.Y - S->WalkStart.Y, 0.0);
		const float Speed = Frames > 0 ? static_cast<float>(Horizontal.Size()) / 100.0f / (Frames / 60.0f) : 0.0f;
		AddInfo(FString::Printf(TEXT("walked %.1f cm over %u applied input frames: %.3f m/s; server velocity off by at most %.3f m/s over %d frames"),
			Horizontal.Size(), Frames, Speed, S->MaxVelocityError, S->VelocitySamples));
		TestTrue(TEXT("enough input frames to measure (>= 60)"), Frames >= 60);
		TestTrue(FString::Printf(TEXT("distance per input frame: %.3f m/s within 5%% of %.1f"), Speed, WalkSpeedMps), FMath::Abs(Speed - WalkSpeedMps) <= 0.05f * WalkSpeedMps);
		TestTrue(FString::Printf(TEXT("server velocity within 5%% of %.1f m/s (worst %.3f off)"), WalkSpeedMps, S->MaxVelocityError), S->MaxVelocityError <= 0.05f * WalkSpeedMps);
		const float Heading = FMath::RadiansToDegrees(FMath::Atan2(Horizontal.Y, Horizontal.X));
		TestTrue(FString::Printf(TEXT("walked toward %.1f deg, faced %.1f"), Heading, S->Yaw), FMath::Abs(FRotator::NormalizeAxis(Heading - S->Yaw)) <= 2.0f);
		S->Events.Reset();
		Click(); // fire the rifle
		S->Deadline = Now() + 5.0;
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S]()
	{
		for (TActorIterator<AVibeShotEffects> It(GameWorld()); It; ++It)
		{
			S->MaxTracers = FMath::Max(S->MaxTracers, It->ActiveTracers());
		}
		const VlEvent* Local = S->Events.FindByPredicate([](const VlEvent& E) { return E.kind == VL_EVENT_LOCAL_SHOT; });
		const VlEvent* Result = Local ? S->Events.FindByPredicate([Local](const VlEvent& E) { return E.kind == VL_EVENT_SHOT_RESULT && E.id == Local->id; }) : nullptr;
		if (Local && Result)
		{
			TestEqual(TEXT("shot weapon"), Local->weapon, (uint32)VL_WEAPON_RIFLE);
			TestTrue(TEXT("a tracer showed"), S->MaxTracers > 0);
			AddInfo(FString::Printf(TEXT("shot %u answered: confirmed %u"), Local->id, Result->a));
			return true;
		}
		if (Now() > S->Deadline)
		{
			AddError(FString::Printf(TEXT("no %s within 5 s"), Local ? TEXT("ShotResult for the shot") : TEXT("local shot")));
			return true;
		}
		return false;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([S]()
	{
		if (UVibeNetSubsystem* Net = NetOf(GameWorld()))
		{
			Net->OnFrame.Remove(S->Handle);
		}
		return true;
	}));
	return true;
}

#endif

#if WITH_DEV_AUTOMATION_TESTS

// VibeCity.Play.ShootRemote: cross-client hit. Aim at the nearest other player (another client on
// the same match: a browser, a bot) through the real input path and fire the rifle; the server must
// confirm a hit on that player (ShotResult: confirmed, hit_player_id). Needs another player within
// the server's interest radius (80 m) and in clear line of sight.
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FVibeCityPlayShootRemote, "VibeCity.Play.ShootRemote",
	EAutomationTestFlags::ClientContext | EAutomationTestFlags::ProductFilter)

bool FVibeCityPlayShootRemote::RunTest(const FString& Parameters)
{
	struct FShootState
	{
		VlLocal Local = {};
		TArray<VlPlayer> Remote;
		TArray<VlEvent> Events;
		FDelegateHandle Handle;
		double Deadline = 0.0;
		uint32 Target = 0;
		int32 Shots = 0;
	};
	TSharedRef<FShootState> S = MakeShared<FShootState>();

	// Joined, and someone else is in view.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S]()
	{
		UVibeNetSubsystem* Net = NetOf(GameWorld());
		if (!Net)
		{
			return false;
		}
		if (!S->Handle.IsValid())
		{
			S->Deadline = Now() + 120.0;
			S->Handle = Net->OnFrame.AddLambda([S](const VlFrameView& Frame)
			{
				S->Local = Frame.local;
				S->Remote.Reset();
				for (size_t i = 0; i < Frame.remote_player_count; ++i)
				{
					S->Remote.Add(Frame.remote_players[i]);
				}
				for (size_t i = 0; i < Frame.event_count; ++i)
				{
					S->Events.Add(Frame.events[i]);
				}
			});
		}
		const bool bJoined = (S->Local.player.flags & VL_PLAYER_VALID) != 0;
		if (bJoined && S->Remote.Num() > 0)
		{
			return true;
		}
		if (Now() > S->Deadline)
		{
			AddError(TEXT("no other player within the server's interest radius"));
			return true;
		}
		return false;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(1.0f));
	// Aim at the nearest one's chest and fire, up to five shots (one every 0.3 s).
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S]()
	{
		if (S->Remote.Num() == 0)
		{
			return true;
		}
		const FVector Eye(S->Local.eye[0], S->Local.eye[1], S->Local.eye[2]);
		const VlPlayer* Nearest = nullptr;
		for (const VlPlayer& P : S->Remote)
		{
			if (!Nearest || FVector::Dist(Eye, FVector(P.pos[0], P.pos[1], P.pos[2])) < FVector::Dist(Eye, FVector(Nearest->pos[0], Nearest->pos[1], Nearest->pos[2])))
			{
				Nearest = &P;
			}
		}
		S->Target = Nearest->player_id;
		// The capsule's centre (the reported position) is mid-torso.
		const FVector Aim = FVector(Nearest->pos[0], Nearest->pos[1], Nearest->pos[2]) - Eye;
		if (APlayerController* PC = UGameplayStatics::GetPlayerController(GameWorld(), 0))
		{
			PC->SetControlRotation(Aim.Rotation());
		}
		AddInfo(FString::Printf(TEXT("aiming at player %u, %.1f m away"), S->Target, Aim.Size() / 100.0));
		S->Deadline = Now() + 6.0;
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(0.5f)); // the view reaches the server
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S]()
	{
		const VlEvent* Hit = S->Events.FindByPredicate([S](const VlEvent& E)
		{
			return E.kind == VL_EVENT_SHOT_RESULT && E.a == 1 && E.player == S->Target;
		});
		if (Hit)
		{
			AddInfo(FString::Printf(TEXT("hit player %u (zone %u) with shot %u after %d shots"), S->Target, Hit->b, Hit->id, S->Shots));
			return true;
		}
		static double NextShot = 0.0;
		if (Now() >= NextShot && S->Shots < 5)
		{
			Click();
			S->Shots += 1;
			NextShot = Now() + 0.3;
		}
		if (Now() > S->Deadline)
		{
			int32 Results = 0;
			for (const VlEvent& E : S->Events)
			{
				Results += E.kind == VL_EVENT_SHOT_RESULT ? 1 : 0;
			}
			AddError(FString::Printf(TEXT("no confirmed hit on player %u: %d shots, %d results"), S->Target, S->Shots, Results));
			return true;
		}
		return false;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([S]()
	{
		if (UVibeNetSubsystem* Net = NetOf(GameWorld()))
		{
			Net->OnFrame.Remove(S->Handle);
		}
		return true;
	}));
	return true;
}

#endif

#if WITH_DEV_AUTOMATION_TESTS

#include "Camera/CameraComponent.h"

// VibeCity.Play.AimAndReset: right mouse narrows the view to the web's 45 degree vertical field of
// view (three.js fields of view are vertical; Unreal's are horizontal, converted at the window's
// aspect) and releasing returns it to 75; R resets the city, which the server answers with a fresh
// wire 4 bootstrap (VlStats::bootstraps).
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FVibeCityPlayAimAndReset, "VibeCity.Play.AimAndReset",
	EAutomationTestFlags::ClientContext | EAutomationTestFlags::ProductFilter)

bool FVibeCityPlayAimAndReset::RunTest(const FString& Parameters)
{
	struct FState
	{
		uint64 Bootstraps = 0;
		uint64 BootstrapsBefore = 0;
		bool bJoined = false;
		FDelegateHandle Handle;
		double Deadline = 0.0;
	};
	TSharedRef<FState> S = MakeShared<FState>();
	auto VerticalFov = []() -> float
	{
		const APawn* Pawn = UGameplayStatics::GetPlayerPawn(GameWorld(), 0);
		const UCameraComponent* Camera = Pawn ? Pawn->FindComponentByClass<UCameraComponent>() : nullptr;
		FVector2D Size(16.0, 9.0);
		GEngine->GameViewport->GetViewportSize(Size);
		const double Aspect = Size.X / FMath::Max(Size.Y, 1.0);
		return Camera ? FMath::RadiansToDegrees(2.0f * FMath::Atan(FMath::Tan(FMath::DegreesToRadians(Camera->FieldOfView) * 0.5f) / Aspect)) : -1.0f;
	};

	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S]()
	{
		UVibeNetSubsystem* Net = NetOf(GameWorld());
		if (!Net)
		{
			return false;
		}
		if (!S->Handle.IsValid())
		{
			S->Deadline = Now() + 90.0;
			S->Handle = Net->OnFrame.AddLambda([S](const VlFrameView& Frame)
			{
				S->Bootstraps = Frame.stats.bootstraps;
				S->bJoined = (Frame.local.player.flags & VL_PLAYER_VALID) != 0;
			});
		}
		if (S->bJoined && S->Bootstraps > 0)
		{
			return true;
		}
		if (Now() > S->Deadline)
		{
			AddError(TEXT("never joined"));
			return true;
		}
		return false;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, VerticalFov]()
	{
		Click();
		TestTrue(FString::Printf(TEXT("hipfire vertical fov %.2f is 75"), VerticalFov()), FMath::Abs(VerticalFov() - 75.0f) < 0.1f);
		Key(EKeys::RightMouseButton, true);
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(1.0f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, VerticalFov]()
	{
		TestTrue(FString::Printf(TEXT("aimed vertical fov %.2f is 45"), VerticalFov()), FMath::Abs(VerticalFov() - 45.0f) < 0.1f);
		Key(EKeys::RightMouseButton, false);
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(1.0f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S, VerticalFov]()
	{
		TestTrue(FString::Printf(TEXT("released vertical fov %.2f is 75"), VerticalFov()), FMath::Abs(VerticalFov() - 75.0f) < 0.1f);
		S->BootstrapsBefore = S->Bootstraps;
		Key(EKeys::R, true);
		Key(EKeys::R, false);
		S->Deadline = Now() + 10.0;
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S]()
	{
		if (S->Bootstraps > S->BootstrapsBefore)
		{
			AddInfo(FString::Printf(TEXT("city reset: bootstrap %llu -> %llu"), S->BootstrapsBefore, S->Bootstraps));
			return true;
		}
		if (Now() > S->Deadline)
		{
			AddError(TEXT("R did not reset the city (no new bootstrap within 10 s)"));
			return true;
		}
		return false;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([S]()
	{
		if (UVibeNetSubsystem* Net = NetOf(GameWorld()))
		{
			Net->OnFrame.Remove(S->Handle);
		}
		return true;
	}));
	return true;
}

#endif
