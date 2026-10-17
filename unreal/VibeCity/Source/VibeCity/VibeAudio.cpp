#include "VibeAudio.h"

#include "Components/AudioComponent.h"
#include "Engine/GameInstance.h"
#include "Kismet/GameplayStatics.h"
#include "Sound/SoundAttenuation.h"
#include "Sound/SoundBase.h"
#include "Sound/SoundWave.h"
#include "VibeLandNet.h"
#include "VibeNetSubsystem.h"

AVibeAudio::AVibeAudio()
{
	PrimaryActorTick.bCanEverTick = true;
}

void AVibeAudio::BeginPlay()
{
	Super::BeginPlay();
	Attenuation = LoadObject<USoundAttenuation>(nullptr, TEXT("/Game/VibeCity/Audio/SA_VibeCity.SA_VibeCity"), nullptr, LOAD_NoWarn | LOAD_Quiet);
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

USoundBase* AVibeAudio::Clip(uint32 Index)
{
	if (TObjectPtr<USoundBase>* Found = Clips.Find(Index))
	{
		return *Found;
	}
	if (Absent.Contains(Index))
	{
		return nullptr;
	}
	const char* Id = vl_audio_clip_id(Index);
	const FString Name = Id ? FString(UTF8_TO_TCHAR(Id)) : FString();
	USoundBase* Sound = Name.IsEmpty() ? nullptr
		: LoadObject<USoundBase>(nullptr, *FString::Printf(TEXT("/Game/VibeCity/Audio/%s.%s"), *Name, *Name), nullptr, LOAD_NoWarn | LOAD_Quiet);
	if (!Sound)
	{
		Absent.Add(Index);
		UE_LOG(LogVibeLand, Display, TEXT("audio clip %u (%s) is not imported (scripts/unreal/import-city-audio.sh); skipping it"), Index, *Name);
		return nullptr;
	}
	Clips.Add(Index, Sound);
	return Sound;
}

void AVibeAudio::Start(const FPending& S)
{
	if (USoundBase* Sound = Clip(S.Clip))
	{
		if (UAudioComponent* Component = UGameplayStatics::SpawnSoundAtLocation(this, Sound, S.Position, FRotator::ZeroRotator, S.Gain, S.Rate, 0.0f, Attenuation))
		{
			// Air absorption and occlusion, as the core decided (engine.ts placeVoice).
			Component->SetLowPassFilterEnabled(true);
			Component->SetLowPassFilterFrequency(S.LowpassHz);
		}
		++PlayedCount;
	}
	else
	{
		++MissingCount;
	}
}

void AVibeAudio::OnFrame(const VlFrameView& Frame)
{
	const double Now = FPlatformTime::Seconds();
	for (size_t i = 0; i < Frame.sound_count; ++i)
	{
		const VlSound& S = Frame.sounds[i];
		const FPending P{ S.clip, FVector(S.position[0], S.position[1], S.position[2]), S.gain, S.rate, Now + FMath::Max(0.0f, S.delay_s), S.lowpass_hz };
		if (S.delay_s <= 0.0f)
		{
			Start(P);
		}
		else
		{
			Pending.Add(P);
		}
	}

	// Loops: start new ids, update live ones, fade out the ones this frame dropped.
	TSet<uint32> Fed;
	for (size_t i = 0; i < Frame.loop_count; ++i)
	{
		const VlLoop& L = Frame.loops[i];
		Fed.Add(L.id);
		const FVector Position(L.position[0], L.position[1], L.position[2]);
		TObjectPtr<UAudioComponent>* Live = Loops.Find(L.id);
		UAudioComponent* Component = Live ? Live->Get() : nullptr;
		if (!Component)
		{
			USoundBase* Sound = Clip(L.clip);
			if (!Sound)
			{
				++MissingCount;
				continue;
			}
			// Scrape and air clips play only as loops.
			if (USoundWave* Wave = Cast<USoundWave>(Sound))
			{
				Wave->bLooping = true;
			}
			Component = UGameplayStatics::SpawnSoundAtLocation(this, Sound, Position, FRotator::ZeroRotator, L.gain, L.rate, 0.0f, Attenuation, nullptr, false);
			if (!Component)
			{
				continue;
			}
			Loops.Add(L.id, Component);
			++LoopsStartedCount;
		}
		Component->SetWorldLocation(Position);
		Component->SetVolumeMultiplier(L.gain);
		Component->SetPitchMultiplier(L.rate);
		Component->SetLowPassFilterEnabled(true);
		Component->SetLowPassFilterFrequency(L.lowpass_hz);
	}
	for (auto It = Loops.CreateIterator(); It; ++It)
	{
		if (!Fed.Contains(It.Key()))
		{
			if (UAudioComponent* Component = It.Value().Get())
			{
				Component->bAutoDestroy = true;
				Component->FadeOut(0.1f, 0.0f);
			}
			It.RemoveCurrent();
		}
	}
}

void AVibeAudio::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	const double Now = FPlatformTime::Seconds();
	for (int32 i = Pending.Num() - 1; i >= 0; --i)
	{
		if (Pending[i].At <= Now)
		{
			Start(Pending[i]);
			Pending.RemoveAtSwap(i);
		}
	}
}
