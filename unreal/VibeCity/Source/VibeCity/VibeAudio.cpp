#include "VibeAudio.h"

#include "Engine/GameInstance.h"
#include "Engine/World.h"
#include "Kismet/GameplayStatics.h"
#include "Sound/SoundAttenuation.h"
#include "Sound/SoundBase.h"
#include "VibeLandNet.h"
#include "VibeNetSubsystem.h"

namespace
{
	constexpr double CellCm = 500.0;      // audio/director.ts: 5 m cells
	constexpr double CellWindowS = 0.065; // ... per 65 ms
	constexpr int32 MaxVoices = 24;
	constexpr double VoiceSeconds = 1.5;   // a clip's typical length, for the voice budget
	constexpr uint32 CollapseChunks = 40;

	/** A clip variant chosen deterministically from an id (the web varies by id too). */
	int32 Variant(uint32 Id, int32 Count)
	{
		return static_cast<int32>((Id * 2654435761u) >> 16) % Count;
	}
}

AVibeAudio::AVibeAudio()
{
	PrimaryActorTick.bCanEverTick = false;
}

void AVibeAudio::BeginPlay()
{
	Super::BeginPlay();
	// Inverse-distance falloff out to the server's audible radius (contact_audio.rs: 200 m).
	Attenuation = NewObject<USoundAttenuation>(this);
	Attenuation->Attenuation.bAttenuate = true;
	Attenuation->Attenuation.bSpatialize = true;
	Attenuation->Attenuation.DistanceAlgorithm = EAttenuationDistanceModel::NaturalSound;
	Attenuation->Attenuation.AttenuationShape = EAttenuationShape::Sphere;
	Attenuation->Attenuation.AttenuationShapeExtents = FVector(500.0, 0.0, 0.0);
	Attenuation->Attenuation.FalloffDistance = 20000.0f;
	const UGameInstance* GameInstance = GetGameInstance();
	if (UVibeNetSubsystem* Net = GameInstance ? GameInstance->GetSubsystem<UVibeNetSubsystem>() : nullptr)
	{
		FrameHandle = Net->OnFrame.AddUObject(this, &AVibeAudio::OnFrame);
	}
}

void AVibeAudio::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
	const UGameInstance* GameInstance = GetGameInstance();
	if (UVibeNetSubsystem* Net = GameInstance ? GameInstance->GetSubsystem<UVibeNetSubsystem>() : nullptr)
	{
		Net->OnFrame.Remove(FrameHandle);
	}
	Super::EndPlay(EndPlayReason);
}

USoundBase* AVibeAudio::Clip(const FString& Name)
{
	if (TObjectPtr<USoundBase>* Found = Clips.Find(Name))
	{
		return *Found;
	}
	if (Absent.Contains(Name))
	{
		return nullptr;
	}
	const FString Path = FString::Printf(TEXT("/Game/VibeCity/Audio/%s.%s"), *Name, *Name);
	USoundBase* Sound = LoadObject<USoundBase>(nullptr, *Path, nullptr, LOAD_NoWarn | LOAD_Quiet);
	if (!Sound)
	{
		Absent.Add(Name);
		UE_LOG(LogVibeLand, Display, TEXT("audio clip %s is not imported; skipping it"), *Path);
		return nullptr;
	}
	Clips.Add(Name, Sound);
	return Sound;
}

void AVibeAudio::Play(const FString& Kind, const FString& ClipName, const FVector& At, float Volume, float Pitch)
{
	const double Now = FPlatformTime::Seconds();
	const FString Cell = FString::Printf(TEXT("%s:%d:%d:%d"), *Kind, FMath::FloorToInt(At.X / CellCm), FMath::FloorToInt(At.Y / CellCm), FMath::FloorToInt(At.Z / CellCm));
	if (const double* Last = RecentCells.Find(Cell); Last && Now - *Last < CellWindowS)
	{
		return;
	}
	RecentCells.Add(Cell, Now);
	VoiceEnds.RemoveAll([Now](double End) { return End <= Now; });
	if (VoiceEnds.Num() >= MaxVoices)
	{
		return;
	}
	USoundBase* Sound = Clip(ClipName);
	if (!Sound)
	{
		++MissingCount;
		return;
	}
	UGameplayStatics::PlaySoundAtLocation(this, Sound, At, FMath::Clamp(Volume, 0.0f, 1.0f), FMath::Clamp(Pitch, 0.5f, 2.0f), 0.0f, Attenuation);
	VoiceEnds.Add(Now + VoiceSeconds);
	++PlayedCount;
	if (RecentCells.Num() > 1024)
	{
		RecentCells.Reset();
	}
}

void AVibeAudio::OnFrame(const VlFrameView& Frame)
{
	LocalPlayerId = Frame.stats.player_id;
	for (size_t i = 0; i < Frame.audio_contact_count; ++i)
	{
		const VlAudioContact& C = Frame.audio_contacts[i];
		const FVector At(C.pos[0], C.pos[1], C.pos[2]);
		// The city's structures are concrete in the default scene; the contact carries no material.
		const float Pitch = 1.0f / FMath::Max(0.6f, FMath::Pow(C.size, 0.35f));
		if (C.kind == VL_CONTACT_SCRAPE)
		{
			Play(TEXT("scrape"), TEXT("concrete-scrape"), At, 0.3f + 0.7f * C.intensity, Pitch);
		}
		else
		{
			Play(TEXT("impact"), FString::Printf(TEXT("concrete-impact-%d"), Variant(C.entity_a ^ C.entity_b, 5)), At, 0.25f + 0.75f * C.intensity, Pitch);
		}
	}
	for (size_t i = 0; i < Frame.event_count; ++i)
	{
		const VlEvent& E = Frame.events[i];
		const FVector P0(E.p0[0], E.p0[1], E.p0[2]);
		switch (E.kind)
		{
		case VL_EVENT_FRACTURE:
			Play(TEXT("fracture"), FString::Printf(TEXT("concrete-fracture-%d"), Variant(E.id + E.a, 3)), P0, FMath::Min(1.0f, 0.4f + E.a / 60.0f), 1.0f);
			if (E.a >= CollapseChunks)
			{
				Play(TEXT("collapse"), FString::Printf(TEXT("collapse-%d"), Variant(E.id, 4)), P0, 1.0f, 1.0f);
			}
			break;
		case VL_EVENT_LOCAL_SHOT:
			Play(TEXT("shot"), FString::Printf(TEXT("shot-%s-%d"), E.weapon == VL_WEAPON_CANNON ? TEXT("cannon") : TEXT("rifle"), Variant(E.id, 3)), P0, 0.8f, 1.0f);
			break;
		case VL_EVENT_SHOT_FIRED:
			if (E.player != LocalPlayerId)
			{
				Play(TEXT("shot"), FString::Printf(TEXT("shot-rifle-%d"), Variant(E.id, 3)), P0, 0.8f, 1.0f);
			}
			break;
		default:
			break;
		}
	}
	for (size_t i = 0; i < Frame.meteor_count; ++i)
	{
		const VlMeteor& M = Frame.meteors[i];
		Play(TEXT("flyby"), FString::Printf(TEXT("flyby-%d"), Variant(M.body_id, 4)), FVector(M.target[0], M.target[1], M.target[2]), 1.0f, 1.0f);
	}
}
