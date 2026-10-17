#include "VibeAudio.h"

#include "Engine/GameInstance.h"
#include "Kismet/GameplayStatics.h"
#include "Sound/SoundAttenuation.h"
#include "Sound/SoundBase.h"
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
		UGameplayStatics::SpawnSoundAtLocation(this, Sound, S.Position, FRotator::ZeroRotator, S.Gain, S.Rate, 0.0f, Attenuation);
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
		const FPending P{ S.clip, FVector(S.position[0], S.position[1], S.position[2]), S.gain, S.rate, Now + FMath::Max(0.0f, S.delay_s) };
		if (S.delay_s <= 0.0f)
		{
			Start(P);
		}
		else
		{
			Pending.Add(P);
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
