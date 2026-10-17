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
	static const TCHAR* WeaponName(uint32 Weapon);

	/** Whether the server has placed this player yet. */
	bool IsJoined() const { return bJoined; }

	/** A car is within reach (E would enter it). */
	bool NearCar() const;

	/** The server has this player in a car. */
	bool IsInVehicle() const { return bInVehicle; }

	/** In the aerial camera (N). */
	bool IsAerial() const { return bAerial; }

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
