#include "VibeNetSubsystem.h"

#include "Engine/Engine.h"
#include "Engine/GameInstance.h"
#include "Engine/World.h"
#include "HAL/IConsoleManager.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "VibeLandNet.h"
#include "VibeNetSettings.h"

void UVibeNetSettings::Resolve(FString& OutApiBaseUrl, FString& OutMatchId)
{
	const UVibeNetSettings* Settings = GetDefault<UVibeNetSettings>();
	OutApiBaseUrl = Settings->ApiBaseUrl;
	OutMatchId = Settings->MatchId;
	FParse::Value(FCommandLine::Get(), TEXT("VibeApi="), OutApiBaseUrl);
	FParse::Value(FCommandLine::Get(), TEXT("VibeMatch="), OutMatchId);
}

void UVibeNetSubsystem::Deinitialize()
{
	Disconnect();
	Super::Deinitialize();
}

bool UVibeNetSubsystem::Connect(const FString& InApiBaseUrl, const FString& InMatchId)
{
	Disconnect();
	if (!FVibeLandNetModule::IsCoreCompatible())
	{
		UE_LOG(LogVibeLand, Error, TEXT("not connecting: client core ABI mismatch"));
		return false;
	}
	ApiBaseUrl = InApiBaseUrl;
	MatchId = InMatchId;

	const FTCHARToUTF8 Api(*ApiBaseUrl);
	const FTCHARToUTF8 Match(*MatchId);
	VlConfig Config;
	Config.api_base_url = Api.Get();
	Config.match_id = Match.Get();
	Config.space = 1; // Unreal: centimetres, Z up
	Client = vl_client_create(&Config);
	if (!Client)
	{
		UE_LOG(LogVibeLand, Error, TEXT("could not create a client for %s match %s"), *ApiBaseUrl, *MatchId);
		return false;
	}
	const int32 Status = vl_client_connect(Client);
	if (Status != VL_OK)
	{
		UE_LOG(LogVibeLand, Error, TEXT("connect failed (%d): %s"), Status, *LastError());
		Disconnect();
		return false;
	}
	UE_LOG(LogVibeLand, Display, TEXT("connecting to %s, match %s"), *ApiBaseUrl, *MatchId);
	return true;
}

void UVibeNetSubsystem::Disconnect()
{
	if (Client)
	{
		vl_client_destroy(Client);
		Client = nullptr;
		Frame = {};
		UE_LOG(LogVibeLand, Display, TEXT("disconnected"));
	}
}

const VlFrameView* UVibeNetSubsystem::Poll()
{
	if (!Client)
	{
		return nullptr;
	}
	const int32 Status = vl_client_poll(Client, &Frame);
	if (Status != VL_OK)
	{
		UE_LOG(LogVibeLand, Error, TEXT("poll failed (%d): %s"), Status, *LastError());
		Disconnect();
		return nullptr;
	}
	OnFrame.Broadcast(Frame);
	return &Frame;
}

void UVibeNetSubsystem::SetInput(const VlInput& Input)
{
	if (Client)
	{
		vl_client_set_input(Client, &Input);
	}
}

uint32 UVibeNetSubsystem::Fire(uint32 Weapon)
{
	uint32 ShotId = 0;
	if (Client)
	{
		vl_client_fire(Client, Weapon, &ShotId);
	}
	return ShotId;
}

bool UVibeNetSubsystem::ChunkMeshes(VlMeshView& Out) const
{
	return Client && vl_client_chunk_meshes(Client, &Out) == VL_OK && Out.range_count > 0;
}

TArrayView<const VlChunkSurface> UVibeNetSubsystem::ChunkSurfaces() const
{
	const VlChunkSurface* Data = nullptr;
	size_t Count = 0;
	if (!Client || vl_client_chunk_surfaces(Client, &Data, &Count) != VL_OK || !Data)
	{
		return {};
	}
	return TArrayView<const VlChunkSurface>(Data, static_cast<int32>(Count));
}

TArrayView<const VlChunk> UVibeNetSubsystem::Chunks() const
{
	if (!Client)
	{
		return {};
	}
	const VlChunk* Data = nullptr;
	size_t Count = 0;
	if (vl_client_chunks(Client, &Data, &Count) != VL_OK || !Data)
	{
		return {};
	}
	return TArrayView<const VlChunk>(Data, static_cast<int32>(Count));
}

FString UVibeNetSubsystem::LastError() const
{
	if (!Client)
	{
		return FString();
	}
	char Buffer[1024];
	const size_t Length = vl_client_last_error(Client, Buffer, sizeof(Buffer));
	return Length ? FString(UTF8_TO_TCHAR(Buffer)) : FString();
}

namespace
{
	UVibeNetSubsystem* SubsystemFor(UWorld* World)
	{
		UGameInstance* GameInstance = World ? World->GetGameInstance() : nullptr;
		return GameInstance ? GameInstance->GetSubsystem<UVibeNetSubsystem>() : nullptr;
	}

	FAutoConsoleCommandWithWorldAndArgs GVibeConnect(
		TEXT("vibe.connect"),
		TEXT("Connect to a vibe-land server: vibe.connect [http://host:port] [match]. Defaults come from project settings and -VibeApi/-VibeMatch."),
		FConsoleCommandWithWorldAndArgsDelegate::CreateLambda([](const TArray<FString>& Args, UWorld* World)
		{
			UVibeNetSubsystem* Net = SubsystemFor(World);
			if (!Net)
			{
				UE_LOG(LogVibeLand, Warning, TEXT("vibe.connect: no game instance (start play first)"));
				return;
			}
			FString Api, Match;
			UVibeNetSettings::Resolve(Api, Match);
			if (Args.Num() > 0) { Api = Args[0]; }
			if (Args.Num() > 1) { Match = Args[1]; }
			Net->Connect(Api, Match);
		}));

	FAutoConsoleCommandWithWorld GVibeDisconnect(
		TEXT("vibe.disconnect"),
		TEXT("Disconnect from the vibe-land server."),
		FConsoleCommandWithWorldDelegate::CreateLambda([](UWorld* World)
		{
			if (UVibeNetSubsystem* Net = SubsystemFor(World))
			{
				Net->Disconnect();
			}
		}));

	FAutoConsoleCommandWithWorld GVibeStatus(
		TEXT("vibe.status"),
		TEXT("Log the vibe-land connection's state and counters."),
		FConsoleCommandWithWorldDelegate::CreateLambda([](UWorld* World)
		{
			UVibeNetSubsystem* Net = SubsystemFor(World);
			if (!Net || !Net->IsConnected())
			{
				UE_LOG(LogVibeLand, Display, TEXT("vibe.status: not connected"));
				return;
			}
			const VlFrameView& F = Net->LastFrame();
			const VlStats& S = F.stats;
			UE_LOG(LogVibeLand, Display,
				TEXT("vibe.status: %s %s transport=%u core=%u player=%u wire=%u chunks=%u bodies=%u remote=%u snapshots=%llu fractures=%llu keyframes=%llu hash=%llu/%llu decode_errors=%llu error='%s'"),
				*Net->CurrentApiBaseUrl(), *Net->CurrentMatchId(), F.transport_state, S.state, S.player_id, S.city_wire,
				S.chunks, S.live_bodies, S.remote_players, S.snapshots, S.fractures, S.keyframes, S.hash_checks,
				S.hash_mismatches, S.decode_errors, *Net->LastError());
		}));
}
