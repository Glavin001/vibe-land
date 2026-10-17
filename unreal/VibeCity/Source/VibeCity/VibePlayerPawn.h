#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Pawn.h"
#include "InputActionValue.h"
#include "vibe_client_core.h"

#include "VibePlayerPawn.generated.h"

class UCameraComponent;
class UInputAction;
class UInputMappingContext;
class UVibeNetSubsystem;

/**
 * The local player on a vibe-land server, first person. The server moves it (a PhysX character
 * controller): this pawn sends what the player does through the shared client core (60 Hz input
 * frames, fire commands) and stands where the core presents it, the server's interpolated pose plus
 * the bounded lead that hides input latency (client-core `predictor.rs`). No local movement
 * simulation, as on the web's /city.
 *
 * Controls match the web client (client/src/input/bindings.ts): WASD move, mouse look, Space jump,
 * Left Shift sprint, C crouch, left mouse fire (held: repeats at the server's fire interval),
 * right mouse aim (75 -> 45 degree field of view, look slowed to 0.45), 1 / 2 / 3 rifle / cannon /
 * meteor, mouse wheel cycles, R resets the city (POST /city-reset, at most once a second), V melee,
 * E enters the nearest car within the server's reach (VEHICLE_INTERACT_RADIUS_M, 4 m) or leaves
 * it; driving uses the same controls (W/S throttle and brake, A/D steer, Space handbrake, R resets
 * the car). N the aerial camera (the web's scene/aerialFlight.ts: free flight at 30 m/s, x3 sprinting, Space
 * and C up and down, gameplay input neutral; leaving drops the player where the camera is).
 */
UCLASS()
class VIBECITY_API AVibePlayerPawn : public APawn
{
	GENERATED_BODY()

public:
	AVibePlayerPawn();

	/** The selected weapon (VL_WEAPON_*). */
	uint32 Weapon() const { return CurrentWeapon; }
	/** Whether the scope is up: aim held, on foot and alive (the web's canUseScopedAim). */
	bool IsAiming() const { return (bAiming || PadLeftTrigger > PadPressed) && CanUseAim(); }
	/** A trigger counts as pressed past this (gamepad.ts PRESSED_EPSILON). */
	static constexpr float PadPressed = 0.35f;
	/** The buttons sent with the last input (tests). */
	uint32 SentButtons() const { return LastSentButtons; }
	static const TCHAR* WeaponName(uint32 Weapon);
	/** Remember the chosen weapon (user settings), unless -VibeFreshSettings. */
	void SaveWeapon() const;

	/** Whether the server has placed this player yet. */
	bool IsJoined() const { return bJoined; }

	/** A car is within reach (E would enter it). */
	bool NearCar() const;

	/** The server has this player in a car. */
	bool IsInVehicle() const { return bInVehicle; }

	/** In the aerial camera (N). */
	bool IsAerial() const { return bAerial; }
	/** The aerial camera's flight speed, m/s (the web's slider: 5 to 100 in steps of 5; the wheel here). */
	int32 AerialSpeed() const { return AerialSpeedMs; }
	/** A camera drop sent and not yet confirmed: the camera holds the drop pose, input is neutral. */
	bool IsDropPending() const { return DropSentAt > 0.0; }
	/** Camera drops sent, and confirmed by the server (tests). */
	int32 DropsSent() const { return DropsSentCount; }
	int32 DropsConfirmed() const { return DropsConfirmedCount; }

protected:
	virtual void BeginPlay() override;
	virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;
	virtual void Tick(float DeltaSeconds) override;
	virtual void SetupPlayerInputComponent(UInputComponent* PlayerInputComponent) override;
	virtual void PawnClientRestart() override;

private:
	void CreateInput();
	void OnMove(const FInputActionValue& Value);
	void OnMoveStopped(const FInputActionValue& Value);
	void OnLook(const FInputActionValue& Value);
	/** Gamepad look this frame (input/gamepad.ts: radial deadzone, response curve, rad/s). */
	void ApplyPadLook(float DeltaSeconds);
	void OnFire(const FInputActionValue& Value);
	void OnFireStopped(const FInputActionValue& Value);
	void OnButton(uint32 Bit, bool bDown);
	void SelectWeapon(uint32 InWeapon);
	void CycleWeapon(const FInputActionValue& Value);

	void OnFrame(const VlFrameView& Frame);
	UVibeNetSubsystem* Net() const;

	UPROPERTY(VisibleAnywhere)
	TObjectPtr<UCameraComponent> Camera;

	UPROPERTY(Transient)
	TObjectPtr<UInputMappingContext> Mapping;
	/** The keys from the player's settings (FVibeSettings), and the web's gamepad defaults. */
	void MapKeys();
	FDelegateHandle SettingsHandle;
	UPROPERTY(Transient)
	TObjectPtr<UInputAction> PadLookAction;
	UPROPERTY(Transient)
	TObjectPtr<UInputAction> PadRightTriggerAction;
	UPROPERTY(Transient)
	TObjectPtr<UInputAction> PadLeftTriggerAction;
	UPROPERTY(Transient)
	TObjectPtr<UInputAction> PadCycleAction;
	FVector2D PadLook = FVector2D::ZeroVector;
	float PadRightTrigger = 0.0f;
	float PadLeftTrigger = 0.0f;
	/** Turn the view by a look input in the mouse path's units (the car orbits instead). */
	void ApplyLook(const FVector2D& Look);
	UPROPERTY(Transient)
	TObjectPtr<UInputAction> MoveAction;
	UPROPERTY(Transient)
	TObjectPtr<UInputAction> LookAction;
	UPROPERTY(Transient)
	TObjectPtr<UInputAction> JumpAction;
	UPROPERTY(Transient)
	TObjectPtr<UInputAction> SprintAction;
	UPROPERTY(Transient)
	TObjectPtr<UInputAction> CrouchAction;
	UPROPERTY(Transient)
	TObjectPtr<UInputAction> FireAction;
	UPROPERTY(Transient)
	TObjectPtr<UInputAction> RifleAction;
	UPROPERTY(Transient)
	TObjectPtr<UInputAction> CannonAction;
	UPROPERTY(Transient)
	TObjectPtr<UInputAction> MeteorAction;
	UPROPERTY(Transient)
	TObjectPtr<UInputAction> CycleAction;
	UPROPERTY(Transient)
	TObjectPtr<UInputAction> AimAction;
	UPROPERTY(Transient)
	TObjectPtr<UInputAction> ResetAction;

	void ResetCity();
	void ToggleAerial();
	void FlyAerial(float DeltaSeconds);

	UPROPERTY(Transient)
	TObjectPtr<UInputAction> MeleeAction;
	UPROPERTY(Transient)
	TObjectPtr<UInputAction> InteractAction;
	void Interact();
	void FollowCar(float DeltaSeconds);
	bool bInVehicle = false;
	bool bDead = false;
	uint32 LastSentButtons = 0;
	/** Fire and aim: on foot and alive (scene/aimControls.ts canUseScopedAim). */
	bool CanUseAim() const { return !bInVehicle && !bDead; }
	uint32 DrivenCar = 0;
	FVector ChaseFocus = FVector::ZeroVector;
	FVector ChaseEye = FVector::ZeroVector;
	bool bChaseValid = false;
	/** The chase camera's orbit about the car's heading (degrees) and its pitch (degrees). */
	float ChaseYawOffset = 0.0f;
	float ChasePitch = 0.0f;
	double LastChaseLookSeconds = 0.0;
	UPROPERTY(Transient)
	TObjectPtr<UInputAction> AerialAction;
	bool bAerial = false;
	FVector AerialEye = FVector::ZeroVector;
	int32 AerialSpeedMs = 30;
	/** When the pending camera drop was sent (0: none), and where it puts the player's capsule centre. */
	double DropSentAt = 0.0;
	int32 DropsSentCount = 0;
	int32 DropsConfirmedCount = 0;
	FVector DropTarget = FVector::ZeroVector;
	void UpdateFieldOfView(float DeltaSeconds);
	bool bAiming = false;
	float VerticalFov = 75.0f;
	double LastResetSeconds = -1.0e9;

	FVector2D MoveAxes = FVector2D::ZeroVector;
	uint32 Buttons = 0;
	bool bFireHeld = false;
	uint32 CurrentWeapon = VL_WEAPON_RIFLE;
	bool bJoined = false;
	bool bOrderedBeforeDirector = false;
	FDelegateHandle FrameHandle;
};
