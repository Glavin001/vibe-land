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
	bWantConnected = true;
	return true;
}

void UVibeNetSubsystem::Disconnect()
{
	bWantConnected = false;
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
	const double Now = FPlatformTime::Seconds();
	if (!Client)
	{
		// A session that dropped (server restart, network) is rejoined after a backoff.
		if (bWantConnected && Now >= ReconnectAt)
		{
			UE_LOG(LogVibeLand, Display, TEXT("reconnecting to %s, match %s"), *ApiBaseUrl, *MatchId);
			const FString Api = ApiBaseUrl, Match = MatchId;
			if (!Connect(Api, Match))
			{
				bWantConnected = true; // keep trying
				ReconnectAt = Now + ReconnectDelayS;
				ReconnectDelayS = FMath::Min(ReconnectDelayS * 2.0, 30.0);
			}
		}
		return nullptr;
	}
	const int32 Status = vl_client_poll(Client, &Frame);
	if (Status != VL_OK)
	{
		UE_LOG(LogVibeLand, Error, TEXT("poll failed (%d): %s"), Status, *LastError());
		DropForReconnect(Now);
		return nullptr;
	}
	if (Frame.transport_state == VL_TRANSPORT_CLOSED || Frame.transport_state == VL_TRANSPORT_FAILED)
	{
		UE_LOG(LogVibeLand, Warning, TEXT("session ended (%s); reconnecting in %.0f s"), *LastError(), ReconnectDelayS);
		OnFrame.Broadcast(Frame);
		DropForReconnect(Now);
		return nullptr;
	}
	if (Frame.stats.state == 3 /* playing */)
	{
		ReconnectDelayS = 2.0;
	}
	OnFrame.Broadcast(Frame);
	return &Frame;
}

void UVibeNetSubsystem::DropForReconnect(double Now)
{
	const bool bWanted = bWantConnected;
	Disconnect();
	bWantConnected = bWanted;
	ReconnectAt = Now + ReconnectDelayS;
	ReconnectDelayS = FMath::Min(ReconnectDelayS * 2.0, 30.0);
}

void UVibeNetSubsystem::SetInput(const VlInput& Input)
{
	if (Client)
	{
		vl_client_set_input(Client, &Input);
	}
}

void UVibeNetSubsystem::SetListener(const FVector& Position)
{
	if (Client)
	{
		vl_client_set_listener(Client, Position.X, Position.Y, Position.Z);
	}
}

void UVibeNetSubsystem::EnterVehicle(uint32 Handle)
{
	if (Client)
	{
		vl_client_enter_vehicle(Client, Handle);
	}
}

void UVibeNetSubsystem::ExitVehicle()
{
	if (Client)
	{
		vl_client_exit_vehicle(Client);
	}
}

namespace
{
	FString VehicleAssetText(VlClient* Client, uint32 Handle, uint32 What)
	{
		if (!Client)
		{
			return FString();
		}
		const size_t Length = vl_client_vehicle_asset(Client, Handle, What, nullptr, 0);
		if (Length == 0)
		{
			return FString();
		}
		TArray<char> Buffer;
		Buffer.SetNumZeroed(static_cast<int32>(Length) + 1);
		vl_client_vehicle_asset(Client, Handle, What, Buffer.GetData(), Buffer.Num());
		return FString(UTF8_TO_TCHAR(Buffer.GetData()));
	}
}

FString UVibeNetSubsystem::VehicleGeometryHash(uint32 Handle) const
{
	return VehicleAssetText(Client, Handle, 0);
}

void UVibeNetSubsystem::SetVehicleMetadata(uint32 Handle, TConstArrayView<uint8> Metadata)
{
	if (Client)
	{
		vl_client_set_vehicle_metadata(Client, Handle, Metadata.GetData(), Metadata.Num());
	}
}

FString UVibeNetSubsystem::VehicleConfiguration(uint32 Handle) const
{
	return VehicleAssetText(Client, Handle, 1);
}

uint32 UVibeNetSubsystem::Melee()
{
	uint32 SwingId = 0;
	if (Client)
	{
		vl_client_melee(Client, &SwingId);
	}
	return SwingId;
}

void UVibeNetSubsystem::CameraDrop(const FVector& Position, float YawDeg, float PitchDeg)
{
	if (Client)
	{
		const float Pos[3] = { static_cast<float>(Position.X), static_cast<float>(Position.Y), static_cast<float>(Position.Z) };
		vl_client_camera_drop(Client, Pos, YawDeg, PitchDeg);
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

TArrayView<const VlGrassExclusion> UVibeNetSubsystem::GrassExclusions() const
{
	const VlGrassExclusion* Data = nullptr;
	size_t Count = 0;
	if (!Client || vl_client_grass_exclusions(Client, &Data, &Count) != VL_OK || !Data)
	{
		return {};
	}
	return TArrayView<const VlGrassExclusion>(Data, static_cast<int32>(Count));
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
