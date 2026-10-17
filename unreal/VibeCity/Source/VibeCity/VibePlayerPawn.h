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
 * 1 / 2 / 3 rifle / cannon / meteor, mouse wheel cycles.
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

	FVector2D MoveAxes = FVector2D::ZeroVector;
	uint32 Buttons = 0;
	bool bFireHeld = false;
	uint32 CurrentWeapon = VL_WEAPON_RIFLE;
	bool bJoined = false;
	bool bOrderedBeforeDirector = false;
	FDelegateHandle FrameHandle;
};
