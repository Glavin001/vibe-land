#pragma once

#include "CoreMinimal.h"
#include "InputCoreTypes.h"

class SWidget;

/**
 * The player's settings, as the web keeps them (input/inputSettings.ts, input/bindings.ts,
 * audio/settings.ts) and saved in the user settings as the web saves them in localStorage:
 * mouse sensitivity, vertical ratio and invert-Y; gamepad look speed, ratio, curve, deadzone and
 * invert-Y; the keyboard bindings; game sound on/off and master volume.
 *
 * -VibeFreshSettings (the play-tests) uses the defaults and saves nothing.
 */
struct VIBECITY_API FVibeSettings
{
	/** The keyboard actions a player can rebind (the web's ControlsSettingsPanel rows for /city). */
	enum class EAction : uint8
	{
		MoveForward, MoveBackward, MoveLeft, MoveRight, Jump, Sprint, Crouch, Melee, Interact, Reset,
		Aim, Rifle, Cannon, Meteor, Aerial, Count
	};

	// Mouse (DEFAULT_INPUT_SETTINGS.mouse; INPUT_SETTINGS_LIMITS).
	static constexpr float DefaultMouseSensitivity = 0.003f;
	float MouseSensitivity = DefaultMouseSensitivity;
	float MouseYOverX = 1.0f;
	bool bMouseInvertY = false;
	// Gamepad (DEFAULT_INPUT_SETTINGS.gamepad).
	float GamepadYawSpeed = 2.8f;
	float GamepadYOverX = 2.1f / 2.8f;
	float GamepadCurveExponent = 2.0f;
	float GamepadAimDeadzone = 0.12f;
	bool bGamepadInvertY = false;
	// Sound (audio/settings.ts DEFAULT_AUDIO: on, master 0.65; the core applies no master gain).
	bool bSoundEnabled = true;
	float MasterVolume = 0.65f;
	/** The mix: settings.ts preset (VL_MIX_*: cinematic by default) and dynamic range (VL_RANGE_*:
	 * balanced by default), applied by the core (vl_client_set_mix). */
	uint32 MixPreset = 0;
	uint32 DynamicRange = 0;

	FKey Keys[static_cast<int32>(EAction::Count)];

	FVibeSettings();

	/** The settings in use (loaded once). */
	static FVibeSettings& Get();
	static const TCHAR* Label(EAction Action);
	static FKey DefaultKey(EAction Action);
	FKey Key(EAction Action) const { return Keys[static_cast<int32>(Action)]; }

	/** Clamp to the web's limits (INPUT_SETTINGS_LIMITS), save, and apply what applies now (volume). */
	void Changed();
	/** Fires after any change, for the pawn to rebuild its key mapping. */
	static FSimpleMulticastDelegate& OnChanged();

	/** Apply the sound settings to the engine's master volume. */
	void ApplySound() const;

	/** The settings panel (Sound and Controls), for the viewport. */
	static TSharedRef<SWidget> MakePanel();

private:
	void Load();
	void Save() const;
};
