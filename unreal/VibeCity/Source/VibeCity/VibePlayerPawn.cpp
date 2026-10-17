#include "VibePlayerPawn.h"

#include "Camera/CameraComponent.h"
#include "Components/SceneComponent.h"
#include "Engine/GameInstance.h"
#include "Engine/LocalPlayer.h"
#include "Engine/Engine.h"
#include "Engine/GameViewportClient.h"
#include "Engine/World.h"
#include "EnhancedInputComponent.h"
#include "EnhancedInputSubsystems.h"
#include "GameFramework/PlayerController.h"
#include "InputAction.h"
#include "InputCoreTypes.h"
#include "InputMappingContext.h"
#include "InputModifiers.h"
#include "EngineUtils.h"
#include "VibeCityDirector.h"
#include "VibeVehicles.h"
#include "GenericPlatform/GenericPlatformHttp.h"
#include "HttpModule.h"
#include "Misc/ConfigCacheIni.h"
#include "GameFramework/InputSettings.h"
#include "VibeSettings.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "VibeLandNet.h"
#include "VibeNetSubsystem.h"

namespace
{
	// scene/GameWorld.tsx: three.js fields of view are vertical.
	constexpr float HipfireVerticalFov = 75.0f;
	constexpr float ScopeVerticalFov = 45.0f;
	constexpr float AimFovDamp = 12.0f;
	constexpr float AimLookMultiplier = 0.45f;
	// city/cityReset.ts.
	constexpr double CityResetCooldownS = 1.0;
	// scene/aerialFlight.ts and App.tsx (aerialSpeed 30).
	// CityFlightControls.tsx: the flight speed slider, 5 to 100 m/s in steps of 5 (30 by default).
	constexpr int32 AerialSpeedMinMs = 5;
	constexpr int32 AerialSpeedMaxMs = 100;
	constexpr int32 AerialSpeedStepMs = 5;
	// GameWorld.tsx: a camera drop is confirmed when the player is within 1 m across and 8 m up or down
	// of where it was dropped, and given up on after 3 s.
	constexpr double DropArrivedAcrossCm = 100.0;
	constexpr double DropArrivedVerticalCm = 800.0;
	constexpr double DropTimeoutS = 3.0;
	constexpr double AerialSprintMultiplier = 3.0;
	constexpr double AerialMaxStepS = 0.1;
	// shared::constants::VEHICLE_INTERACT_RADIUS_M.
	constexpr double VehicleInteractRadiusCm = 400.0;
	// input/resolver.ts: the chase camera's pitch and its return to centre.
	constexpr float ChaseDefaultPitchDeg = 8.594367f; // 0.15 rad
	constexpr float ChasePitchMinDeg = -20.053523f;   // -0.35 rad
	constexpr float ChasePitchMaxDeg = 34.377468f;    // 0.6 rad
	constexpr float ChaseYawReturnDegS = 143.239449f; // 2.5 rad/s
	constexpr float ChasePitchReturnDegS = 85.943669f; // 1.5 rad/s
	constexpr double ChaseIdleS = 0.3;

	/** Control rotation pitch in (-180, 180], as the core expects (Unreal keeps it in [0, 360)). */
	float SignedPitch(float Pitch)
	{
		return FRotator::NormalizeAxis(Pitch);
	}
}

AVibePlayerPawn::AVibePlayerPawn()
{
	PrimaryActorTick.bCanEverTick = true;
	// Before the director polls the core this frame (TG_PrePhysics too; ordered in BeginPlay), so
	// the input it sends is this frame's.
	PrimaryActorTick.TickGroup = TG_PrePhysics;

	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	Camera = CreateDefaultSubobject<UCameraComponent>(TEXT("Camera"));
	Camera->SetupAttachment(RootComponent);
	// The eye: shared::constants::PLAYER_EYE_HEIGHT_M above the server's reported position.
	Camera->SetRelativeLocation(FVector(0.0, 0.0, 100.0 * VL_EYE_HEIGHT_M));
	Camera->bUsePawnControlRotation = true;
	// Set each frame from the web's vertical field of view and the viewport's aspect (UpdateFieldOfView).
	Camera->SetFieldOfView(90.0f);
	// The web draws no motion blur.
	Camera->PostProcessSettings.bOverride_MotionBlurAmount = true;
	Camera->PostProcessSettings.MotionBlurAmount = 0.0f;

	bUseControllerRotationYaw = false;
	bUseControllerRotationPitch = false;
	AutoPossessPlayer = EAutoReceiveInput::Disabled;
	SetActorEnableCollision(false);
}

UVibeNetSubsystem* AVibePlayerPawn::Net() const
{
	const UGameInstance* GameInstance = GetGameInstance();
	return GameInstance ? GameInstance->GetSubsystem<UVibeNetSubsystem>() : nullptr;
}

namespace
{
	// The chosen weapon is remembered across sessions, as the web keeps it in localStorage
	// (city/shotMode.ts). -VibeFreshSettings (the play-tests) starts from the rifle and saves nothing.
	const TCHAR* SettingsSection = TEXT("VibeCity");
	bool FreshSettings() { return FParse::Param(FCommandLine::Get(), TEXT("VibeFreshSettings")); }
}

void AVibePlayerPawn::BeginPlay()
{
	Super::BeginPlay();
	int32 Saved = 0;
	if (!FreshSettings() && GConfig && GConfig->GetInt(SettingsSection, TEXT("Weapon"), Saved, GGameUserSettingsIni)
		&& (Saved == VL_WEAPON_RIFLE || Saved == VL_WEAPON_CANNON || Saved == VL_WEAPON_METEOR))
	{
		CurrentWeapon = static_cast<uint32>(Saved);
	}
	if (UVibeNetSubsystem* NetSubsystem = Net())
	{
		FrameHandle = NetSubsystem->OnFrame.AddUObject(this, &AVibePlayerPawn::OnFrame);
	}
}

void AVibePlayerPawn::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
	if (UVibeNetSubsystem* NetSubsystem = Net())
	{
		NetSubsystem->OnFrame.Remove(FrameHandle);
	}
	Super::EndPlay(EndPlayReason);
}

void AVibePlayerPawn::CreateInput()
{
	if (Mapping)
	{
		return;
	}
	auto Action = [this](const TCHAR* Name, EInputActionValueType Type)
	{
		UInputAction* A = NewObject<UInputAction>(this, Name);
		A->ValueType = Type;
		return A;
	};
	MoveAction = Action(TEXT("IA_Move"), EInputActionValueType::Axis2D);
	LookAction = Action(TEXT("IA_Look"), EInputActionValueType::Axis2D);
	JumpAction = Action(TEXT("IA_Jump"), EInputActionValueType::Boolean);
	SprintAction = Action(TEXT("IA_Sprint"), EInputActionValueType::Boolean);
	CrouchAction = Action(TEXT("IA_Crouch"), EInputActionValueType::Boolean);
	FireAction = Action(TEXT("IA_Fire"), EInputActionValueType::Boolean);
	RifleAction = Action(TEXT("IA_Rifle"), EInputActionValueType::Boolean);
	CannonAction = Action(TEXT("IA_Cannon"), EInputActionValueType::Boolean);
	MeteorAction = Action(TEXT("IA_Meteor"), EInputActionValueType::Boolean);
	CycleAction = Action(TEXT("IA_CycleWeapon"), EInputActionValueType::Axis1D);
	AimAction = Action(TEXT("IA_Aim"), EInputActionValueType::Boolean);
	ResetAction = Action(TEXT("IA_ResetCity"), EInputActionValueType::Boolean);
	MeleeAction = Action(TEXT("IA_Melee"), EInputActionValueType::Boolean);
	InteractAction = Action(TEXT("IA_Interact"), EInputActionValueType::Boolean);
	AerialAction = Action(TEXT("IA_Aerial"), EInputActionValueType::Boolean);

	PadLookAction = Action(TEXT("IA_PadLook"), EInputActionValueType::Axis2D);
	PadRightTriggerAction = Action(TEXT("IA_PadRightTrigger"), EInputActionValueType::Axis1D);
	PadLeftTriggerAction = Action(TEXT("IA_PadLeftTrigger"), EInputActionValueType::Axis1D);
	PadCycleAction = Action(TEXT("IA_PadCycleOrReset"), EInputActionValueType::Boolean);
	Mapping = NewObject<UInputMappingContext>(this, TEXT("IMC_VibeCity"));
	MapKeys();
	// Rebind live when the player changes a key in the settings.
	SettingsHandle = FVibeSettings::OnChanged().AddWeakLambda(this, [this]()
	{
		MapKeys();
		if (UVibeNetSubsystem* NetSubsystem = Net())
		{
			NetSubsystem->SetMix(FVibeSettings::Get().MixPreset, FVibeSettings::Get().DynamicRange);
		}
		const APlayerController* PC = Cast<APlayerController>(GetController());
		const ULocalPlayer* LocalPlayer = PC ? PC->GetLocalPlayer() : nullptr;
		if (UEnhancedInputLocalPlayerSubsystem* Input = LocalPlayer ? LocalPlayer->GetSubsystem<UEnhancedInputLocalPlayerSubsystem>() : nullptr)
		{
			Input->RequestRebuildControlMappings();
		}
	});
	FVibeSettings::Get().ApplySound();
	if (UVibeNetSubsystem* NetSubsystem = Net())
	{
		NetSubsystem->SetMix(FVibeSettings::Get().MixPreset, FVibeSettings::Get().DynamicRange);
	}
}

void AVibePlayerPawn::MapKeys()
{
	using EAction = FVibeSettings::EAction;
	const FVibeSettings& Settings = FVibeSettings::Get();
	Mapping->UnmapAll();
	// Move: X right, Y forward. Forward/back drive Y (swizzled), back and left negated.
	auto Negate = [this]() { return NewObject<UInputModifierNegate>(Mapping); };
	auto ToY = [this]() { return NewObject<UInputModifierSwizzleAxis>(Mapping); }; // default order YXZ
	Mapping->MapKey(MoveAction, Settings.Key(EAction::MoveForward)).Modifiers.Add(ToY());
	{
		FEnhancedActionKeyMapping& S = Mapping->MapKey(MoveAction, Settings.Key(EAction::MoveBackward));
		S.Modifiers.Add(ToY());
		S.Modifiers.Add(Negate());
	}
	Mapping->MapKey(MoveAction, Settings.Key(EAction::MoveLeft)).Modifiers.Add(Negate());
	Mapping->MapKey(MoveAction, Settings.Key(EAction::MoveRight));
	// Look: mouse up looks up (the first-person template's negated Y).
	{
		FEnhancedActionKeyMapping& Look = Mapping->MapKey(LookAction, EKeys::Mouse2D);
		UInputModifierNegate* NegateY = Negate();
		NegateY->bX = false;
		NegateY->bZ = false;
		Look.Modifiers.Add(NegateY);
	}
	Mapping->MapKey(JumpAction, Settings.Key(EAction::Jump));
	Mapping->MapKey(SprintAction, Settings.Key(EAction::Sprint));
	Mapping->MapKey(CrouchAction, Settings.Key(EAction::Crouch));
	Mapping->MapKey(FireAction, EKeys::LeftMouseButton);
	Mapping->MapKey(RifleAction, Settings.Key(EAction::Rifle));
	Mapping->MapKey(CannonAction, Settings.Key(EAction::Cannon));
	Mapping->MapKey(MeteorAction, Settings.Key(EAction::Meteor));
	Mapping->MapKey(CycleAction, EKeys::MouseWheelAxis);
	Mapping->MapKey(AimAction, EKeys::RightMouseButton);
	Mapping->MapKey(AimAction, Settings.Key(EAction::Aim)); // input/bindings.ts aimSecondaryKey
	Mapping->MapKey(ResetAction, Settings.Key(EAction::Reset));
	Mapping->MapKey(MeleeAction, Settings.Key(EAction::Melee));
	Mapping->MapKey(InteractAction, Settings.Key(EAction::Interact));
	Mapping->MapKey(AerialAction, Settings.Key(EAction::Aerial));

	// Gamepad (input/bindings.ts DEFAULT_BINDINGS.gamepad, standard mapping): left stick moves (radial
	// deadzone 0.18, gamepad.ts LEFT_STICK_DEADZONE), right stick looks (ApplyPadLook), A jumps (the
	// handbrake in a car), B crouches and melees, X interacts, Y switches weapon (resets the car in
	// one), left stick click sprints, RT fires (throttle in a car), LT aims (brake in a car).
	{
		FEnhancedActionKeyMapping& Stick = Mapping->MapKey(MoveAction, EKeys::Gamepad_Left2D);
		UInputModifierDeadZone* Dead = NewObject<UInputModifierDeadZone>(Mapping);
		Dead->Type = EDeadZoneType::Radial;
		Dead->LowerThreshold = 0.18f;
		Dead->UpperThreshold = 1.0f;
		Stick.Modifiers.Add(Dead);
	}
	Mapping->MapKey(PadLookAction, EKeys::Gamepad_Right2D);
	Mapping->MapKey(JumpAction, EKeys::Gamepad_FaceButton_Bottom);
	Mapping->MapKey(CrouchAction, EKeys::Gamepad_FaceButton_Right);
	Mapping->MapKey(MeleeAction, EKeys::Gamepad_FaceButton_Right);
	Mapping->MapKey(InteractAction, EKeys::Gamepad_FaceButton_Left);
	Mapping->MapKey(PadCycleAction, EKeys::Gamepad_FaceButton_Top);
	Mapping->MapKey(SprintAction, EKeys::Gamepad_LeftThumbstick);
	Mapping->MapKey(PadRightTriggerAction, EKeys::Gamepad_RightTriggerAxis);
	Mapping->MapKey(PadLeftTriggerAction, EKeys::Gamepad_LeftTriggerAxis);
}

void AVibePlayerPawn::PawnClientRestart()
{
	Super::PawnClientRestart();
	CreateInput();
	const APlayerController* PC = Cast<APlayerController>(GetController());
	const ULocalPlayer* LocalPlayer = PC ? PC->GetLocalPlayer() : nullptr;
	if (UEnhancedInputLocalPlayerSubsystem* Input = LocalPlayer ? LocalPlayer->GetSubsystem<UEnhancedInputLocalPlayerSubsystem>() : nullptr)
	{
		Input->ClearAllMappings();
		Input->AddMappingContext(Mapping, 0);
	}
}

void AVibePlayerPawn::SetupPlayerInputComponent(UInputComponent* PlayerInputComponent)
{
	Super::SetupPlayerInputComponent(PlayerInputComponent);
	CreateInput();
	UEnhancedInputComponent* Input = Cast<UEnhancedInputComponent>(PlayerInputComponent);
	if (!Input)
	{
		UE_LOG(LogVibeLand, Error, TEXT("the player input component is not an Enhanced Input component; no controls"));
		return;
	}
	Input->BindAction(MoveAction, ETriggerEvent::Triggered, this, &AVibePlayerPawn::OnMove);
	Input->BindAction(MoveAction, ETriggerEvent::Completed, this, &AVibePlayerPawn::OnMoveStopped);
	Input->BindAction(LookAction, ETriggerEvent::Triggered, this, &AVibePlayerPawn::OnLook);
	Input->BindActionValueLambda(JumpAction, ETriggerEvent::Started, [this](const FInputActionValue&) { OnButton(VL_BTN_JUMP, true); });
	Input->BindActionValueLambda(JumpAction, ETriggerEvent::Completed, [this](const FInputActionValue&) { OnButton(VL_BTN_JUMP, false); });
	Input->BindActionValueLambda(SprintAction, ETriggerEvent::Started, [this](const FInputActionValue&) { OnButton(VL_BTN_SPRINT, true); });
	Input->BindActionValueLambda(SprintAction, ETriggerEvent::Completed, [this](const FInputActionValue&) { OnButton(VL_BTN_SPRINT, false); });
	Input->BindActionValueLambda(CrouchAction, ETriggerEvent::Started, [this](const FInputActionValue&) { OnButton(VL_BTN_CROUCH, true); });
	Input->BindActionValueLambda(CrouchAction, ETriggerEvent::Completed, [this](const FInputActionValue&) { OnButton(VL_BTN_CROUCH, false); });
	Input->BindAction(FireAction, ETriggerEvent::Started, this, &AVibePlayerPawn::OnFire);
	Input->BindAction(FireAction, ETriggerEvent::Completed, this, &AVibePlayerPawn::OnFireStopped);
	// Weapon slots, the wheel, melee and aim are on-foot actions (input/keyboardMouse.ts contexts).
	Input->BindActionValueLambda(RifleAction, ETriggerEvent::Started, [this](const FInputActionValue&) { if (!bInVehicle) SelectWeapon(VL_WEAPON_RIFLE); });
	Input->BindActionValueLambda(CannonAction, ETriggerEvent::Started, [this](const FInputActionValue&) { if (!bInVehicle) SelectWeapon(VL_WEAPON_CANNON); });
	Input->BindActionValueLambda(MeteorAction, ETriggerEvent::Started, [this](const FInputActionValue&) { if (!bInVehicle) SelectWeapon(VL_WEAPON_METEOR); });
	Input->BindAction(CycleAction, ETriggerEvent::Triggered, this, &AVibePlayerPawn::CycleWeapon);
	Input->BindActionValueLambda(AimAction, ETriggerEvent::Started, [this](const FInputActionValue&) { bAiming = true; });
	Input->BindActionValueLambda(AimAction, ETriggerEvent::Completed, [this](const FInputActionValue&) { bAiming = false; });
	// R: in a car, the car's reset button (held like the others); on foot, the city reset.
	Input->BindActionValueLambda(ResetAction, ETriggerEvent::Started, [this](const FInputActionValue&)
	{
		if (bInVehicle)
		{
			OnButton(VL_BTN_RELOAD, true);
		}
		else if (!bAerial)
		{
			ResetCity();
		}
	});
	Input->BindActionValueLambda(ResetAction, ETriggerEvent::Completed, [this](const FInputActionValue&) { OnButton(VL_BTN_RELOAD, false); });
	Input->BindActionValueLambda(InteractAction, ETriggerEvent::Started, [this](const FInputActionValue&) { Interact(); });
	Input->BindActionValueLambda(MeleeAction, ETriggerEvent::Started, [this](const FInputActionValue&)
	{
		if (UVibeNetSubsystem* NetSubsystem = Net(); NetSubsystem && bJoined && !bAerial && !bInVehicle)
		{
			NetSubsystem->Melee();
		}
	});
	Input->BindActionValueLambda(AerialAction, ETriggerEvent::Started, [this](const FInputActionValue&) { ToggleAerial(); });
	Input->BindActionValueLambda(PadLookAction, ETriggerEvent::Triggered, [this](const FInputActionValue& V) { PadLook = V.Get<FVector2D>(); });
	Input->BindActionValueLambda(PadLookAction, ETriggerEvent::Completed, [this](const FInputActionValue&) { PadLook = FVector2D::ZeroVector; });
	Input->BindActionValueLambda(PadRightTriggerAction, ETriggerEvent::Triggered, [this](const FInputActionValue& V) { PadRightTrigger = V.Get<float>(); });
	Input->BindActionValueLambda(PadRightTriggerAction, ETriggerEvent::Completed, [this](const FInputActionValue&) { PadRightTrigger = 0.0f; });
	Input->BindActionValueLambda(PadLeftTriggerAction, ETriggerEvent::Triggered, [this](const FInputActionValue& V) { PadLeftTrigger = V.Get<float>(); });
	Input->BindActionValueLambda(PadLeftTriggerAction, ETriggerEvent::Completed, [this](const FInputActionValue&) { PadLeftTrigger = 0.0f; });
	// Y: the car's reset in one (held, like R), the next weapon on foot (gamepad.ts switchWeaponButton).
	Input->BindActionValueLambda(PadCycleAction, ETriggerEvent::Started, [this](const FInputActionValue&)
	{
		if (bInVehicle)
		{
			OnButton(VL_BTN_RELOAD, true);
		}
		else
		{
			CycleWeapon(FInputActionValue(1.0f));
		}
	});
	Input->BindActionValueLambda(PadCycleAction, ETriggerEvent::Completed, [this](const FInputActionValue&) { OnButton(VL_BTN_RELOAD, false); });
}

void AVibePlayerPawn::OnMove(const FInputActionValue& Value)
{
	MoveAxes = Value.Get<FVector2D>();
}

void AVibePlayerPawn::OnMoveStopped(const FInputActionValue&)
{
	MoveAxes = FVector2D::ZeroVector;
}

void AVibePlayerPawn::OnLook(const FInputActionValue& Value)
{
	// The player's mouse settings, relative to the web's default sensitivity (inputSettings.ts).
	const FVibeSettings& S = FVibeSettings::Get();
	const float Gain = S.MouseSensitivity / FVibeSettings::DefaultMouseSensitivity;
	FVector2D Look = Value.Get<FVector2D>();
	Look.X *= Gain;
	Look.Y *= Gain * S.MouseYOverX * (S.bMouseInvertY ? -1.0f : 1.0f);
	ApplyLook(Look);
}

void AVibePlayerPawn::ApplyPadLook(float DeltaSeconds)
{
	if (PadLook.IsNearlyZero())
	{
		return;
	}
	const FVibeSettings& S = FVibeSettings::Get();
	// gamepad.ts: radial deadzone rescaled to the rim, then sign(v)·|v|^exponent per axis, at the yaw
	// speed (rad/s) and pitch = yaw × ratio.
	const double Magnitude = PadLook.Size();
	if (Magnitude <= S.GamepadAimDeadzone)
	{
		return;
	}
	const FVector2D Stick = PadLook * (((Magnitude - S.GamepadAimDeadzone) / (1.0 - S.GamepadAimDeadzone)) / Magnitude);
	auto Shape = [&S](double V) { return FMath::Sign(V) * FMath::Pow(FMath::Abs(V), S.GamepadCurveExponent); };
	const double YawDeg = FMath::RadiansToDegrees(Shape(Stick.X) * S.GamepadYawSpeed * DeltaSeconds);
	const double PitchDeg = FMath::RadiansToDegrees(Shape(Stick.Y) * S.GamepadYawSpeed * S.GamepadYOverX * DeltaSeconds)
		* (S.bGamepadInvertY ? -1.0 : 1.0);
	// Into the mouse path's units: degrees over the controller's (legacy) input scale, pitch in the
	// sense of the mouse's negated Y (stick up looks up).
	const APlayerController* PC = Cast<APlayerController>(GetController());
	const bool bLegacy = GetDefault<UInputSettings>()->bEnableLegacyInputScales;
	const double YawScale = PC && bLegacy ? PC->InputYawScale_DEPRECATED : 1.0;
	const double PitchScale = PC && bLegacy ? -PC->InputPitchScale_DEPRECATED : 1.0;
	ApplyLook(FVector2D(YawDeg / FMath::Max(YawScale, 1e-3), PitchDeg / FMath::Max(PitchScale, 1e-3)));
}

void AVibePlayerPawn::ApplyLook(const FVector2D& Raw)
{
	const FVector2D Look = Raw * (IsAiming() ? AimLookMultiplier : 1.0f);
	if (bInVehicle)
	{
		// In a car the mouse orbits the chase camera about the car (input/resolver.ts); the legacy
		// input scale (2.5 degrees per unit) keeps the feel of on-foot look.
		ChaseYawOffset += Look.X * 2.5f;
		ChasePitch = FMath::Clamp(ChasePitch + Look.Y * 2.5f, ChasePitchMinDeg, ChasePitchMaxDeg);
		LastChaseLookSeconds = FPlatformTime::Seconds();
		return;
	}
	AddControllerYawInput(Look.X);
	AddControllerPitchInput(Look.Y);
}

void AVibePlayerPawn::OnFire(const FInputActionValue&)
{
	bFireHeld = true;
}

void AVibePlayerPawn::OnFireStopped(const FInputActionValue&)
{
	bFireHeld = false;
}

void AVibePlayerPawn::OnButton(uint32 Bit, bool bDown)
{
	Buttons = bDown ? (Buttons | Bit) : (Buttons & ~Bit);
}

const TCHAR* AVibePlayerPawn::WeaponName(uint32 Weapon)
{
	switch (Weapon)
	{
	case VL_WEAPON_RIFLE: return TEXT("Rifle");
	case VL_WEAPON_CANNON: return TEXT("Cannon");
	case VL_WEAPON_METEOR: return TEXT("Meteor strike");
	default: return TEXT("?");
	}
}

void AVibePlayerPawn::SelectWeapon(uint32 InWeapon)
{
	CurrentWeapon = InWeapon;
	SaveWeapon();
}

void AVibePlayerPawn::SaveWeapon() const
{
	if (!FreshSettings() && GConfig)
	{
		GConfig->SetInt(SettingsSection, TEXT("Weapon"), static_cast<int32>(CurrentWeapon), GGameUserSettingsIni);
		GConfig->Flush(false, GGameUserSettingsIni);
	}
}

void AVibePlayerPawn::CycleWeapon(const FInputActionValue& Value)
{
	// The web's cycle (city/shotMode.ts): rifle, cannon, meteor.
	static const uint32 Order[] = { VL_WEAPON_RIFLE, VL_WEAPON_CANNON, VL_WEAPON_METEOR };
	const float Step = Value.Get<float>();
	if (bAerial && !FMath::IsNearlyZero(Step))
	{
		// Flying, the wheel sets the flight speed (the web's slider).
		AerialSpeedMs = FMath::Clamp(AerialSpeedMs + (Step > 0.0f ? AerialSpeedStepMs : -AerialSpeedStepMs), AerialSpeedMinMs, AerialSpeedMaxMs);
		return;
	}
	if (FMath::IsNearlyZero(Step) || bInVehicle)
	{
		return;
	}
	int32 Index = 0;
	for (int32 i = 0; i < UE_ARRAY_COUNT(Order); ++i)
	{
		if (Order[i] == CurrentWeapon)
		{
			Index = i;
		}
	}
	Index = (Index + (Step > 0.0f ? 1 : -1) + UE_ARRAY_COUNT(Order)) % UE_ARRAY_COUNT(Order);
	SelectWeapon(Order[Index]);
}

void AVibePlayerPawn::ResetCity()
{
	const double Now = FPlatformTime::Seconds();
	UVibeNetSubsystem* NetSubsystem = Net();
	if (!NetSubsystem || !NetSubsystem->IsConnected() || Now - LastResetSeconds < CityResetCooldownS)
	{
		return;
	}
	LastResetSeconds = Now;
	const FString Url = FString::Printf(TEXT("%s/city-reset/%s"), *NetSubsystem->CurrentApiBaseUrl(), *FGenericPlatformHttp::UrlEncode(NetSubsystem->CurrentMatchId()));
	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(Url);
	Request->SetVerb(TEXT("POST"));
	Request->OnProcessRequestComplete().BindLambda([Url](FHttpRequestPtr, FHttpResponsePtr Response, bool bOk)
	{
		UE_LOG(LogVibeLand, Display, TEXT("city reset %s: %s"), *Url, bOk && Response ? *FString::FromInt(Response->GetResponseCode()) : TEXT("failed"));
	});
	Request->ProcessRequest();
}

void AVibePlayerPawn::Interact()
{
	UVibeNetSubsystem* NetSubsystem = Net();
	if (!NetSubsystem || !bJoined || bAerial)
	{
		return;
	}
	if (bInVehicle)
	{
		NetSubsystem->ExitVehicle();
		return;
	}
	TActorIterator<AVibeVehicles> Vehicles(GetWorld());
	if (TOptional<uint32> Car = Vehicles ? Vehicles->NearestCar(GetActorLocation(), VehicleInteractRadiusCm) : TOptional<uint32>())
	{
		DrivenCar = *Car;
		bChaseValid = false;
		NetSubsystem->EnterVehicle(*Car);
	}
}

bool AVibePlayerPawn::NearCar() const
{
	TActorIterator<AVibeVehicles> Vehicles(GetWorld());
	return bJoined && !bAerial && Vehicles && Vehicles->NearestCar(GetActorLocation(), VehicleInteractRadiusCm).IsSet();
}

void AVibePlayerPawn::FollowCar(float DeltaSeconds)
{
	// The web's chase camera (scene/GameWorld.tsx): focus 1 m above the chassis, 6 m behind along the
	// car's heading plus the mouse's orbit, 1 m higher, smoothed (rates 12 and 18 per second).
	TActorIterator<AVibeVehicles> Vehicles(GetWorld());
	TOptional<FVector> Chassis = Vehicles ? Vehicles->CarPosition(DrivenCar) : TOptional<FVector>();
	TOptional<FQuat> Rotation = Vehicles ? Vehicles->CarRotation(DrivenCar) : TOptional<FQuat>();
	AController* PC = GetController();
	if (!Chassis || !Rotation || !PC)
	{
		return;
	}
	if (!bChaseValid)
	{
		ChaseYawOffset = 0.0f;
		ChasePitch = ChaseDefaultPitchDeg;
	}
	if (FPlatformTime::Seconds() - LastChaseLookSeconds > ChaseIdleS)
	{
		ChaseYawOffset = FMath::FixedTurn(ChaseYawOffset, 0.0f, ChaseYawReturnDegS * DeltaSeconds);
		ChasePitch = FMath::FixedTurn(ChasePitch, ChaseDefaultPitchDeg, ChasePitchReturnDegS * DeltaSeconds);
	}
	const float OrbitYaw = static_cast<float>(Rotation->Rotator().Yaw) + ChaseYawOffset;
	const double FollowCm = 600.0;
	const FVector Focus = *Chassis + FVector(0.0, 0.0, 100.0);
	const FVector Back = FRotator(0.0, OrbitYaw, 0.0).Vector() * (FMath::Cos(FMath::DegreesToRadians(ChasePitch)) * FollowCm);
	const FVector Target = Focus - Back + FVector(0.0, 0.0, FMath::Sin(FMath::DegreesToRadians(ChasePitch)) * FollowCm + 100.0);
	if (!bChaseValid)
	{
		ChaseFocus = Focus;
		ChaseEye = Target;
		bChaseValid = true;
	}
	ChaseFocus += (Focus - ChaseFocus) * FMath::Min(DeltaSeconds * 12.0f, 1.0f);
	ChaseEye += (Target - ChaseEye) * FMath::Min(DeltaSeconds * 18.0f, 1.0f);
	SetActorLocation(ChaseEye - Camera->GetRelativeLocation());
	PC->SetControlRotation((ChaseFocus - ChaseEye).Rotation());
}

void AVibePlayerPawn::ToggleAerial()
{
	if (!bJoined)
	{
		return;
	}
	const AController* PC = GetController();
	if (!bAerial)
	{
		bAerial = true;
		AerialEye = Camera->GetComponentLocation();
		return;
	}
	bAerial = false;
	// Drop the player where the camera is (the server places its capsule centre there; the eye is
	// the eye height above it).
	if (UVibeNetSubsystem* NetSubsystem = Net(); NetSubsystem && PC)
	{
		const FRotator View = PC->GetControlRotation();
		DropTarget = AerialEye - FVector(0.0, 0.0, 100.0 * VL_EYE_HEIGHT_M);
		NetSubsystem->CameraDrop(DropTarget, View.Yaw, SignedPitch(View.Pitch));
		DropSentAt = FPlatformTime::Seconds();
		++DropsSentCount;
	}
}

void AVibePlayerPawn::FlyAerial(float DeltaSeconds)
{
	const AController* PC = GetController();
	if (!PC)
	{
		return;
	}
	const FRotator View = PC->GetControlRotation();
	const FVector Forward = View.Vector();
	const FVector Right = FRotator(0.0, View.Yaw, 0.0).RotateVector(FVector::RightVector);
	const double Vertical = ((Buttons & VL_BTN_JUMP) ? 1.0 : 0.0) - ((Buttons & VL_BTN_CROUCH) ? 1.0 : 0.0);
	FVector Move = Forward * MoveAxes.Y + Right * MoveAxes.X + FVector::UpVector * Vertical;
	const double Length = FMath::Max(1.0, Move.Size());
	const double Step = FMath::Clamp(static_cast<double>(DeltaSeconds), 0.0, AerialMaxStepS)
		* 100.0 * AerialSpeedMs * ((Buttons & VL_BTN_SPRINT) ? AerialSprintMultiplier : 1.0) / Length;
	AerialEye += Move * Step;
	SetActorLocation(AerialEye - Camera->GetRelativeLocation());
}

void AVibePlayerPawn::UpdateFieldOfView(float DeltaSeconds)
{
	const float Target = IsAiming() ? ScopeVerticalFov : HipfireVerticalFov;
	VerticalFov = FMath::Lerp(Target, VerticalFov, FMath::Exp(-AimFovDamp * DeltaSeconds));
	// Unreal's field of view is horizontal: keep the web's vertical one at any aspect.
	FVector2D Size(16.0, 9.0);
	if (GEngine && GEngine->GameViewport)
	{
		GEngine->GameViewport->GetViewportSize(Size);
	}
	const double Aspect = Size.Y > 0.0 ? Size.X / Size.Y : 16.0 / 9.0;
	const double Horizontal = 2.0 * FMath::Atan(FMath::Tan(FMath::DegreesToRadians(VerticalFov) * 0.5) * Aspect);
	Camera->SetFieldOfView(static_cast<float>(FMath::RadiansToDegrees(Horizontal)));
}

void AVibePlayerPawn::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	UpdateFieldOfView(DeltaSeconds);
	if (!bOrderedBeforeDirector)
	{
		// The director polls the core; this frame's input must be in before it does. (It is spawned
		// by the game mode's StartPlay, possibly after this pawn's BeginPlay.)
		for (TActorIterator<AVibeCityDirector> It(GetWorld()); It; ++It)
		{
			It->AddTickPrerequisiteActor(this);
			bOrderedBeforeDirector = true;
		}
	}
	UVibeNetSubsystem* NetSubsystem = Net();
	const AController* PC = GetController();
	if (!NetSubsystem || !PC)
	{
		return;
	}
	ApplyPadLook(DeltaSeconds);
	const FRotator View = PC->GetControlRotation();
	VlInput Input = {};
	Input.yaw = static_cast<float>(View.Yaw);
	Input.pitch = SignedPitch(static_cast<float>(View.Pitch));
	if (bAerial)
	{
		// The camera flies; the player gets neutral input (it stands where it was).
		FlyAerial(DeltaSeconds);
		NetSubsystem->SetInput(Input);
		return;
	}
	if (IsDropPending())
	{
		// Dropped: hold the camera at the drop until the server has the player there (OnFrame).
		SetActorLocation(AerialEye - Camera->GetRelativeLocation());
		NetSubsystem->SetInput(Input);
		return;
	}
	Input.move_x = static_cast<float>(MoveAxes.X);
	Input.move_y = static_cast<float>(MoveAxes.Y);
	if (bInVehicle && FMath::IsNearlyZero(Input.move_y))
	{
		// gamepad.ts: in a car RT is the throttle and LT the brake.
		Input.move_y = FMath::Clamp(PadRightTrigger - PadLeftTrigger, -1.0f, 1.0f);
	}
	// In a car Space stays (the handbrake rides the jump bit); sprint and crouch are on-foot only.
	Input.buttons = bInVehicle ? (Buttons & ~(VL_BTN_SPRINT | VL_BTN_CROUCH)) : Buttons;
	LastSentButtons = Input.buttons;
	NetSubsystem->SetInput(Input);
	if ((bFireHeld || PadRightTrigger > PadPressed) && bJoined && CanUseAim())
	{
		// The core repeats at most at the server's fire interval and stamps the shot.
		NetSubsystem->Fire(CurrentWeapon);
	}
}

void AVibePlayerPawn::OnFrame(const VlFrameView& Frame)
{
	const VlPlayer& Me = Frame.local.player;
	if (!(Me.flags & VL_PLAYER_VALID))
	{
		return;
	}
	bInVehicle = (Me.state_flags & VL_STATE_IN_VEHICLE) != 0;
	bDead = (Me.state_flags & VL_STATE_DEAD) != 0;
	if (IsDropPending())
	{
		const FVector At(Me.pos[0], Me.pos[1], Me.pos[2]);
		const bool bArrived = FVector::Dist2D(At, DropTarget) < DropArrivedAcrossCm
			&& FMath::Abs(At.Z - DropTarget.Z) < DropArrivedVerticalCm && !bInVehicle;
		if (bArrived || FPlatformTime::Seconds() - DropSentAt > DropTimeoutS)
		{
			if (!bArrived)
			{
				UE_LOG(LogVibeLand, Warning, TEXT("camera drop was not confirmed by the server"));
			}
			DropsConfirmedCount += bArrived ? 1 : 0;
			DropSentAt = 0.0;
		}
	}
	if (bInVehicle)
	{
		FollowCar(static_cast<float>(GetWorld()->GetDeltaSeconds()));
	}
	else if (!bAerial && !IsDropPending())
	{
		SetActorLocation(FVector(Me.pos[0], Me.pos[1], Me.pos[2]));
	}
	if (!bJoined)
	{
		bJoined = true;
		// Face where the server spawned us.
		if (AController* PC = GetController())
		{
			PC->SetControlRotation(FRotator(Me.pitch, Me.yaw, 0.0f));
		}
		UE_LOG(LogVibeLand, Display, TEXT("playing as player %u at %s"), Me.player_id, *GetActorLocation().ToString());
	}
}
