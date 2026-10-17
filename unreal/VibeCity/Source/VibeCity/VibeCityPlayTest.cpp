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

#if WITH_DEV_AUTOMATION_TESTS

#include "VibeDynamicBodies.h"

// VibeCity.Play.CannonAndMeteor: weapons 2 and 3 through the real input path. The cannon's ball must
// appear among the snapshot's bodies (drawn by AVibeDynamicBodies); a meteor called on the city must
// be announced (its flight drawn) and break something (the city stream's fracture count rises).
// Needs a PhysX server (the synthetic city has no colliders: no meteor is launched there).
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FVibeCityPlayCannonAndMeteor, "VibeCity.Play.CannonAndMeteor",
	EAutomationTestFlags::ClientContext | EAutomationTestFlags::ProductFilter)

bool FVibeCityPlayCannonAndMeteor::RunTest(const FString& Parameters)
{
	struct FState
	{
		VlLocal Local = {};
		uint64 Fractures = 0;
		uint64 FracturesBefore = 0;
		int32 MaxBodies = 0;
		float MaxBallRadiusCm = 0.0f;
		int32 Meteors = 0;
		int32 MaxFlights = 0;
		FDelegateHandle Handle;
		double Deadline = 0.0;
	};
	TSharedRef<FState> S = MakeShared<FState>();
	auto Bodies = []() -> AVibeDynamicBodies*
	{
		TActorIterator<AVibeDynamicBodies> It(GameWorld());
		return It ? *It : nullptr;
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
				S->Local = Frame.local;
				S->Fractures = Frame.stats.fractures;
				S->MaxBodies = FMath::Max(S->MaxBodies, static_cast<int32>(Frame.dynamic_body_count));
				for (size_t i = 0; i < Frame.dynamic_body_count; ++i)
				{
					S->MaxBallRadiusCm = FMath::Max(S->MaxBallRadiusCm, Frame.dynamic_bodies[i].half_extents[0]);
				}
				S->Meteors += static_cast<int32>(Frame.meteor_count);
			});
		}
		if (S->Local.player.flags & VL_PLAYER_VALID)
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
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(1.5f));
	// Face the city's centre, a little down: a building or the street is in the line of fire.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([S]()
	{
		Click();
		const FVector Eye(S->Local.eye[0], S->Local.eye[1], S->Local.eye[2]);
		const FVector Target(0.0, 0.0, 400.0);
		if (APlayerController* PC = UGameplayStatics::GetPlayerController(GameWorld(), 0))
		{
			PC->SetControlRotation((Target - Eye).Rotation());
		}
		Key(EKeys::Two, true);
		Key(EKeys::Two, false);
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(0.5f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([S]()
	{
		Click(); // fire the cannon
		S->Deadline = Now() + 4.0;
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S, Bodies]()
	{
		if (const AVibeDynamicBodies* B = Bodies())
		{
			S->MaxBodies = FMath::Max(S->MaxBodies, B->VisibleBodies());
		}
		if (S->MaxBodies > 0 || Now() > S->Deadline)
		{
			TestTrue(TEXT("the cannonball appeared among the snapshot's bodies"), S->MaxBodies > 0);
			AddInfo(FString::Printf(TEXT("cannon: %d body(ies), radius %.1f cm"), S->MaxBodies, S->MaxBallRadiusCm));
			return true;
		}
		return false;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([S]()
	{
		Key(EKeys::Three, true);
		Key(EKeys::Three, false);
		S->FracturesBefore = S->Fractures;
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(0.3f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([S]()
	{
		Click(); // call the meteor
		S->Deadline = Now() + 30.0;
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S, Bodies]()
	{
		if (const AVibeDynamicBodies* B = Bodies())
		{
			S->MaxFlights = FMath::Max(S->MaxFlights, B->FlyingMeteors());
		}
		if ((S->Meteors > 0 && S->Fractures > S->FracturesBefore) || Now() > S->Deadline)
		{
			TestTrue(TEXT("the meteor launch was announced"), S->Meteors > 0);
			TestTrue(TEXT("its flight was drawn"), S->MaxFlights > 0);
			TestTrue(FString::Printf(TEXT("the meteor broke something (fractures %llu -> %llu)"), S->FracturesBefore, S->Fractures), S->Fractures > S->FracturesBefore);
			AddInfo(FString::Printf(TEXT("meteor: %d launch(es), fractures %llu -> %llu"), S->Meteors, S->FracturesBefore, S->Fractures));
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

// VibeCity.Play.AerialAndMelee: N flies the camera (the web's aerialFlight: 30 m/s along the view)
// while the server player stands; N again drops the player at the camera (the server puts its
// capsule there, within 1 m horizontally); V swings (the server sets the meleeing flag on the
// player for a swing it executed).
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FVibeCityPlayAerialAndMelee, "VibeCity.Play.AerialAndMelee",
	EAutomationTestFlags::ClientContext | EAutomationTestFlags::ProductFilter)

bool FVibeCityPlayAerialAndMelee::RunTest(const FString& Parameters)
{
	struct FState
	{
		VlLocal Local = {};
		bool bSawMeleeFlag = false;
		FDelegateHandle Handle;
		double Deadline = 0.0;
		double FlyStart = 0.0;
		FVector EyeStart = FVector::ZeroVector;
		FVector PlayerStart = FVector::ZeroVector;
		FVector DropEye = FVector::ZeroVector;
	};
	TSharedRef<FState> S = MakeShared<FState>();
	auto PlayerPos = [S]() { return FVector(S->Local.player.pos[0], S->Local.player.pos[1], S->Local.player.pos[2]); };
	auto Pawn = []() { return Cast<AVibePlayerPawn>(UGameplayStatics::GetPlayerPawn(GameWorld(), 0)); };
	auto CameraEye = [Pawn]() -> FVector
	{
		const AVibePlayerPawn* P = Pawn();
		const UCameraComponent* C = P ? P->FindComponentByClass<UCameraComponent>() : nullptr;
		return C ? C->GetComponentLocation() : FVector::ZeroVector;
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
				S->Local = Frame.local;
				S->bSawMeleeFlag |= (Frame.local.player.state_flags & VL_STATE_MELEEING) != 0;
			});
		}
		if (S->Local.player.flags & VL_PLAYER_VALID)
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
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(1.5f));
	// Melee first, on the ground.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([S]()
	{
		Click();
		Key(EKeys::V, true);
		Key(EKeys::V, false);
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(1.0f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S, PlayerPos, CameraEye]()
	{
		TestTrue(TEXT("V swung (the server set the meleeing flag)"), S->bSawMeleeFlag);
		// Into the aerial camera, facing away from the city, level.
		S->Deadline = 0.0;
		const FVector P = PlayerPos();
		if (APlayerController* PC = UGameplayStatics::GetPlayerController(GameWorld(), 0))
		{
			PC->SetControlRotation(FRotator(0.0, FMath::RadiansToDegrees(FMath::Atan2(P.Y, P.X)), 0.0));
		}
		Key(EKeys::N, true);
		Key(EKeys::N, false);
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(0.2f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S, Pawn, PlayerPos, CameraEye]()
	{
		TestTrue(TEXT("N entered the aerial camera"), Pawn() && Pawn()->IsAerial());
		S->EyeStart = CameraEye();
		S->PlayerStart = PlayerPos();
		S->FlyStart = Now();
		Key(EKeys::W, true);
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(1.5f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S, PlayerPos, CameraEye]()
	{
		Key(EKeys::W, false);
		const double Seconds = Now() - S->FlyStart;
		const double Flown = FVector::Dist(CameraEye(), S->EyeStart) / 100.0;
		const double Speed = Flown / Seconds;
		AddInfo(FString::Printf(TEXT("aerial: flew %.1f m in %.2f s (%.1f m/s)"), Flown, Seconds, Speed));
		// Frames cap at 0.1 s each, so a hitch only slows it; within 10% of 30 m/s otherwise.
		TestTrue(FString::Printf(TEXT("aerial speed %.1f m/s near 30"), Speed), Speed > 27.0 && Speed < 31.0);
		TestTrue(TEXT("the player stood still meanwhile"), FVector::Dist2D(PlayerPos(), S->PlayerStart) < 50.0);
		S->DropEye = CameraEye();
		Key(EKeys::N, true);
		Key(EKeys::N, false);
		S->Deadline = Now() + 5.0;
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S, PlayerPos]()
	{
		const double Off = FVector::Dist2D(PlayerPos(), S->DropEye);
		if (Off < 100.0 || Now() > S->Deadline)
		{
			AddInfo(FString::Printf(TEXT("dropped: player %.2f m from the camera's spot"), Off / 100.0));
			TestTrue(FString::Printf(TEXT("the drop put the player at the camera (%.2f m off)"), Off / 100.0), Off < 100.0);
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

#include "UnrealClient.h"
#include "VibeVehicles.h"

// VibeCity.Play.Drive: the cars the stream carries are drawn (their meshes built from the server's
// metadata.json); E beside one puts the player in it (the server's FLAG_IN_VEHICLE); W drives it
// (it moves); E again leaves it. Needs a server whose city fields cars (the PhysX city does).
// -VibeShotDir=<dir> also saves a screenshot of the car being driven.
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FVibeCityPlayDrive, "VibeCity.Play.Drive",
	EAutomationTestFlags::ClientContext | EAutomationTestFlags::ProductFilter)

bool FVibeCityPlayDrive::RunTest(const FString& Parameters)
{
	struct FState
	{
		VlLocal Local = {};
		FDelegateHandle Handle;
		double Deadline = 0.0;
		uint32 Car = 0;
		FVector CarStart = FVector::ZeroVector;
		float Tick = 0.0f;
		float TickStart = 0.0f;
	};
	TSharedRef<FState> S = MakeShared<FState>();
	auto Vehicles = []() -> AVibeVehicles*
	{
		TActorIterator<AVibeVehicles> It(GameWorld());
		return It ? *It : nullptr;
	};
	auto Pawn = []() { return Cast<AVibePlayerPawn>(UGameplayStatics::GetPlayerPawn(GameWorld(), 0)); };

	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S, Vehicles]()
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
				S->Local = Frame.local;
				S->Tick = Frame.stats.player_render_tick;
			});
		}
		const AVibeVehicles* V = Vehicles();
		if ((S->Local.player.flags & VL_PLAYER_VALID) && V && V->BuiltCars() > 0)
		{
			AddInfo(FString::Printf(TEXT("cars: %d carried, %d built"), V->CarCount(), V->BuiltCars()));
			return true;
		}
		if (Now() > S->Deadline)
		{
			AddError(FString::Printf(TEXT("no car drawn (cars %d, built %d)"), V ? V->CarCount() : -1, V ? V->BuiltCars() : -1));
			return true;
		}
		return false;
	}));
	// Stand beside the nearest car.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S, Vehicles]()
	{
		const AVibeVehicles* V = Vehicles();
		const FVector Me(S->Local.player.pos[0], S->Local.player.pos[1], S->Local.player.pos[2]);
		TOptional<uint32> Car = V ? V->NearestCar(Me, 1.0e9) : TOptional<uint32>();
		if (!Car)
		{
			AddError(TEXT("no car to drive"));
			return true;
		}
		S->Car = *Car;
		const FVector At = *V->CarPosition(*Car);
		if (UVibeNetSubsystem* Net = NetOf(GameWorld()))
		{
			Net->CameraDrop(At + FVector(0.0, 250.0, 150.0), 0.0f, 0.0f);
		}
		AddInfo(FString::Printf(TEXT("car %u at %s"), *Car, *At.ToString()));
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(2.0f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([S, Vehicles]()
	{
		Click();
		Key(EKeys::E, true);
		Key(EKeys::E, false);
		S->Deadline = Now() + 5.0;
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S, Pawn, Vehicles]()
	{
		if (Pawn() && Pawn()->IsInVehicle())
		{
			S->CarStart = *Vehicles()->CarPosition(S->Car);
			S->TickStart = S->Tick;
			Key(EKeys::W, true);
			S->Deadline = Now() + 30.0;
			return true;
		}
		if (Now() > S->Deadline)
		{
			AddError(TEXT("E did not put the player in the car"));
			S->Deadline = 0.0;
			return true;
		}
		return false;
	}));
	// Hold the throttle for server time, not wall time: in a car the server applies one input per
	// tick, and a server sharing its GPU can tick well below real time.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([S]() { return S->Tick - S->TickStart >= 60.0f || Now() > S->Deadline; }));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S, Vehicles]()
	{
		if (const AVibeVehicles* V = Vehicles())
		{
			const TOptional<VlCar> C = V->LastCar(S->Car);
			for (int32 W = 0; W < 4; ++W)
			{
				const TOptional<FVector> P = V->WheelPosition(S->Car, W);
				AddInfo(FString::Printf(TEXT("wheel %d at %s (car %s): travel %.2f steer %.3f spin %.2f grounded %u; car flags %u"), W,
					P ? *P->ToString() : TEXT("?"), *V->CarPosition(S->Car)->ToString(), C ? C->wheels[W].travel : 0.f,
					C ? C->wheels[W].steer : 0.f, C ? C->wheels[W].spin : 0.f, C ? C->wheels[W].grounded : 0u, C ? C->flags : 0u));
			}
		}
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([]()
	{
		// Mid-drive, so the frame is the chase camera's.
		FString ShotDir;
		if (FParse::Value(FCommandLine::Get(), TEXT("VibeShotDir="), ShotDir))
		{
			FScreenshotRequest::RequestScreenshot(ShotDir / TEXT("drive.png"), false, false);
		}
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([S]() { return S->Tick - S->TickStart >= 120.0f || Now() > S->Deadline; }));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S, Vehicles]()
	{
		Key(EKeys::W, false);
		const float Ticks = S->Tick - S->TickStart;
		AddInfo(FString::Printf(TEXT("throttle held for %.0f server ticks"), Ticks));
		TestTrue(TEXT("the server simulated 120 ticks of throttle within 30 s"), Ticks >= 120.0f);
		const FVector End = *Vehicles()->CarPosition(S->Car);
		const double Moved = FVector::Dist2D(End, S->CarStart) / 100.0;
		AddInfo(FString::Printf(TEXT("drove car %u %.1f m; input next %u acked %u; in vehicle %d"), S->Car, Moved,
			S->Local.next_input_seq, S->Local.ack_input_seq, (S->Local.player.state_flags & VL_STATE_IN_VEHICLE) ? 1 : 0));
		TestTrue(FString::Printf(TEXT("W drove the car (%.1f m)"), Moved), Moved > 2.0);
		{
			const APawn* P = UGameplayStatics::GetPlayerPawn(GameWorld(), 0);
			const UCameraComponent* C = P ? P->FindComponentByClass<UCameraComponent>() : nullptr;
			const TOptional<FQuat> R = Vehicles()->CarRotation(S->Car);
			AddInfo(FString::Printf(TEXT("camera %s looking %s; car %s yaw %.1f"), C ? *C->GetComponentLocation().ToString() : TEXT("?"),
				C ? *C->GetComponentRotation().ToString() : TEXT("?"), *End.ToString(), R ? R->Rotator().Yaw : 0.0));
		}
		Key(EKeys::E, true);
		Key(EKeys::E, false);
		S->Deadline = Now() + 5.0;
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S, Pawn]()
	{
		if (Pawn() && !Pawn()->IsInVehicle())
		{
			return true;
		}
		if (Now() > S->Deadline)
		{
			AddError(TEXT("E did not take the player out of the car"));
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

#include "VibeRemotePlayers.h"

// VibeCity.Play.LookAtRemote: walk up to (drop 5 m from) the nearest other player, face them and
// take a screenshot (-VibeShotDir=<dir>, remote.png); the other player is drawn by AVibeRemotePlayers.
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FVibeCityPlayLookAtRemote, "VibeCity.Play.LookAtRemote",
	EAutomationTestFlags::ClientContext | EAutomationTestFlags::ProductFilter)

bool FVibeCityPlayLookAtRemote::RunTest(const FString& Parameters)
{
	struct FState
	{
		VlLocal Local = {};
		TArray<VlPlayer> Remote;
		FDelegateHandle Handle;
		double Deadline = 0.0;
		FVector Target = FVector::ZeroVector;
	};
	TSharedRef<FState> S = MakeShared<FState>();
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
				S->Local = Frame.local;
				S->Remote = TArray<VlPlayer>(Frame.remote_players, static_cast<int32>(Frame.remote_player_count));
			});
		}
		if ((S->Local.player.flags & VL_PLAYER_VALID) && S->Remote.Num() > 0)
		{
			return true;
		}
		if (Now() > S->Deadline)
		{
			AddError(TEXT("no other player in interest"));
			return true;
		}
		return false;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([S]()
	{
		const VlPlayer& P = S->Remote[0];
		S->Target = FVector(P.pos[0], P.pos[1], P.pos[2]);
		const FVector Me(S->Local.player.pos[0], S->Local.player.pos[1], S->Local.player.pos[2]);
		const FVector Toward = (S->Target - Me).GetSafeNormal2D();
		if (UVibeNetSubsystem* Net = NetOf(GameWorld()))
		{
			Net->CameraDrop(S->Target - Toward * 500.0 + FVector(0.0, 0.0, 50.0), static_cast<float>(Toward.Rotation().Yaw), 0.0f);
		}
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(2.5f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, S]()
	{
		const FVector Eye(S->Local.eye[0], S->Local.eye[1], S->Local.eye[2]);
		if (APlayerController* PC = UGameplayStatics::GetPlayerController(GameWorld(), 0))
		{
			PC->SetControlRotation((S->Target - Eye).Rotation());
		}
		TActorIterator<AVibeRemotePlayers> Players(GameWorld());
		AddInfo(FString::Printf(TEXT("%.1f m from player %u; %d drawn, mannequin %d"), FVector::Dist(Eye, S->Target) / 100.0,
			S->Remote[0].player_id, Players ? Players->VisiblePlayers() : -1, Players && Players->UsesMannequin() ? 1 : 0));
		TestTrue(TEXT("the other player is drawn"), Players && Players->VisiblePlayers() > 0);
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(0.5f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([S]()
	{
		FString ShotDir;
		if (FParse::Value(FCommandLine::Get(), TEXT("VibeShotDir="), ShotDir))
		{
			FScreenshotRequest::RequestScreenshot(ShotDir / TEXT("remote.png"), false, false);
		}
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(0.5f));
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
