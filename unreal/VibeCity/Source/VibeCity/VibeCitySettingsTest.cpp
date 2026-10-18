// VibeCity.Settings: the player's settings (FVibeSettings) are the web's.
//
//  * the defaults equal the web's tables (inputSettings.ts DEFAULT_INPUT_SETTINGS, bindings.ts
//    DEFAULT_BINDINGS.keyboard, audio/settings.ts DEFAULT_AUDIO's master);
//  * values clamp to INPUT_SETTINGS_LIMITS;
//  * a key rebound in the settings works at once: Jump moved to J makes J send the jump bit, and the
//    old key no longer does;
//  * freeing the cursor (Esc) shows the settings panel; capturing it hides it.
// Run in the game (scripts/unreal/play-tests.sh --only VibeCity.Settings; -VibeFreshSettings saves nothing).

#include "Engine/Engine.h"
#include "Engine/GameViewportClient.h"
#include "Engine/World.h"
#include "Framework/Application/SlateApplication.h"
#include "Kismet/GameplayStatics.h"
#include "Misc/AutomationTest.h"
#include "Tests/AutomationCommon.h"
#include "VibeCityPlayerController.h"
#include "VibePlayerPawn.h"
#include "VibeSettings.h"
#include "vibe_client_core.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace
{
	UWorld* SettingsTestWorld()
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

	void SettingsKey(const FKey& Key, bool bDown)
	{
		FSlateApplication& Slate = FSlateApplication::Get();
		const FKeyEvent Event(Key, FModifierKeysState(), Slate.GetUserIndexForKeyboard(), false, 0, 0);
		bDown ? Slate.ProcessKeyDownEvent(Event) : Slate.ProcessKeyUpEvent(Event);
	}

	AVibePlayerPawn* SettingsPawn() { return Cast<AVibePlayerPawn>(UGameplayStatics::GetPlayerPawn(SettingsTestWorld(), 0)); }
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FVibeCitySettings, "VibeCity.Settings",
	EAutomationTestFlags::ClientContext | EAutomationTestFlags::ProductFilter)

bool FVibeCitySettings::RunTest(const FString& Parameters)
{
	using EAction = FVibeSettings::EAction;
	const FVibeSettings Defaults;
	TestEqual(TEXT("mouse sensitivity 0.003"), Defaults.MouseSensitivity, 0.003f);
	TestEqual(TEXT("mouse ratio 1"), Defaults.MouseYOverX, 1.0f);
	TestFalse(TEXT("mouse not inverted"), Defaults.bMouseInvertY);
	TestEqual(TEXT("gamepad yaw 2.8 rad/s"), Defaults.GamepadYawSpeed, 2.8f);
	TestEqual(TEXT("gamepad ratio 2.1/2.8"), Defaults.GamepadYOverX, 2.1f / 2.8f);
	TestEqual(TEXT("gamepad curve 2"), Defaults.GamepadCurveExponent, 2.0f);
	TestEqual(TEXT("gamepad deadzone 0.12"), Defaults.GamepadAimDeadzone, 0.12f);
	TestEqual(TEXT("master volume 0.65"), Defaults.MasterVolume, 0.65f);
	TestTrue(TEXT("sound on"), Defaults.bSoundEnabled);
	TestEqual(TEXT("mix: cinematic (settings.ts DEFAULT_AUDIO.preset)"), Defaults.MixPreset, static_cast<uint32>(VL_MIX_CINEMATIC));
	TestEqual(TEXT("dynamic range: balanced"), Defaults.DynamicRange, static_cast<uint32>(VL_RANGE_BALANCED));
	const TPair<EAction, FKey> Keyboard[] = {
		{ EAction::MoveForward, EKeys::W }, { EAction::MoveBackward, EKeys::S }, { EAction::MoveLeft, EKeys::A },
		{ EAction::MoveRight, EKeys::D }, { EAction::Jump, EKeys::SpaceBar }, { EAction::Sprint, EKeys::LeftShift },
		{ EAction::Crouch, EKeys::C }, { EAction::Melee, EKeys::V }, { EAction::Interact, EKeys::E },
		{ EAction::Reset, EKeys::R }, { EAction::Aim, EKeys::LeftAlt }, { EAction::Rifle, EKeys::One },
		{ EAction::Cannon, EKeys::Two }, { EAction::Meteor, EKeys::Three }, { EAction::Aerial, EKeys::N },
	};
	for (const TPair<EAction, FKey>& K : Keyboard)
	{
		TestEqual(*FString::Printf(TEXT("%s on %s"), FVibeSettings::Label(K.Key), *K.Value.ToString()), Defaults.Key(K.Key), K.Value);
	}
	{
		FVibeSettings Clamped;
		Clamped.MouseSensitivity = 1.0f;
		Clamped.MouseYOverX = 0.0f;
		Clamped.GamepadAimDeadzone = 1.0f;
		Clamped.MasterVolume = 2.0f;
		Clamped.MixPreset = 7;
		Clamped.Changed(); // a copy: clamps and saves nothing under -VibeFreshSettings
		TestEqual(TEXT("sensitivity clamps to 0.01"), Clamped.MouseSensitivity, 0.01f);
		TestEqual(TEXT("ratio clamps to 0.4"), Clamped.MouseYOverX, 0.4f);
		TestEqual(TEXT("deadzone clamps to 0.25"), Clamped.GamepadAimDeadzone, 0.25f);
		TestEqual(TEXT("volume clamps to 1"), Clamped.MasterVolume, 1.0f);
		TestEqual(TEXT("an unknown preset clamps to the last"), Clamped.MixPreset, static_cast<uint32>(VL_MIX_CLARITY));
	}

	// Live rebinding, in the game.
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Started = FPlatformTime::Seconds()]()
	{
		const AVibePlayerPawn* P = SettingsPawn();
		if (P && P->IsJoined())
		{
			return true;
		}
		if (FPlatformTime::Seconds() - Started > 60.0)
		{
			AddError(TEXT("never joined"));
			return true;
		}
		return false;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([]()
	{
		FVibeSettings& S = FVibeSettings::Get();
		S.Keys[static_cast<int32>(EAction::Jump)] = EKeys::J;
		S.Changed();
		return true;
	}));
	// The mapping rebuilds on the next input tick; then capture the cursor (a click) and press J.
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(0.3f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([]()
	{
		if (AVibeCityPlayerController* PC = Cast<AVibeCityPlayerController>(UGameplayStatics::GetPlayerController(SettingsTestWorld(), 0)))
		{
			PC->CaptureCursor();
		}
		SettingsKey(EKeys::J, true);
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(0.3f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this]()
	{
		const AVibePlayerPawn* P = SettingsPawn();
		TestTrue(TEXT("J, rebound to Jump, sends the jump bit"), P && (P->SentButtons() & VL_BTN_JUMP) != 0);
		SettingsKey(EKeys::J, false);
		SettingsKey(EKeys::SpaceBar, true);
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(0.3f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this]()
	{
		const AVibePlayerPawn* P = SettingsPawn();
		TestTrue(TEXT("Space, no longer Jump, sends no jump bit"), P && (P->SentButtons() & VL_BTN_JUMP) == 0);
		SettingsKey(EKeys::SpaceBar, false);
		FVibeSettings& S = FVibeSettings::Get();
		S.Keys[static_cast<int32>(EAction::Jump)] = EKeys::SpaceBar;
		S.Changed();
		// Esc frees the cursor and shows the settings.
		SettingsKey(EKeys::Escape, true);
		SettingsKey(EKeys::Escape, false);
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FWaitLatentCommand(0.3f));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this]()
	{
		const AVibeCityPlayerController* PC = Cast<AVibeCityPlayerController>(UGameplayStatics::GetPlayerController(SettingsTestWorld(), 0));
		TestTrue(TEXT("Esc freed the cursor"), PC && PC->IsCursorFree());
		TestTrue(TEXT("the settings panel shows while the cursor is free"), PC && PC->SettingsShown());
		return true;
	}));
	return true;
}

#endif
