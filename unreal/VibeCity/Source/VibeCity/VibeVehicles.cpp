#include "VibeVehicles.h"

#include "Async/Async.h"
#include "Components/SceneComponent.h"
#include "Engine/GameInstance.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Materials/MaterialInterface.h"
#include "ProceduralMeshComponent.h"
#include "VibeLandNet.h"
#include "VibeNetSubsystem.h"

namespace
{
	UVibeNetSubsystem* NetFor(const AActor* Actor)
	{
		const UGameInstance* GameInstance = Actor ? Actor->GetGameInstance() : nullptr;
		return GameInstance ? GameInstance->GetSubsystem<UVibeNetSubsystem>() : nullptr;
	}

	FLinearColor FromRgba(uint32 Rgba)
	{
		return FLinearColor(FColor((Rgba >> 24) & 0xFF, (Rgba >> 16) & 0xFF, (Rgba >> 8) & 0xFF, Rgba & 0xFF));
	}

	/** The triangles of one component, grouped by colour. */
	struct FSectionMesh
	{
		TMap<uint32, TArray<FVector>> Positions;
		TMap<uint32, TArray<FVector>> Normals;
	};

	/** A posed part's frame (renderer space, actor frame; scale per the part's own axes). */
	FTransform PartTransform(const float Pos[3], const float Quat[4], const float Scale[3])
	{
		return FTransform(FQuat(Quat[0], Quat[1], Quat[2], Quat[3]), FVector(Pos[0], Pos[1], Pos[2]), FVector(Scale[0], Scale[1], Scale[2]));
	}
}

AVibeVehicles::AVibeVehicles()
{
	PrimaryActorTick.bCanEverTick = false;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
}

void AVibeVehicles::BeginPlay()
{
	Super::BeginPlay();
	if (UVibeNetSubsystem* Net = NetFor(this))
	{
		FrameHandle = Net->OnFrame.AddUObject(this, &AVibeVehicles::OnFrame);
	}
}

void AVibeVehicles::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
	for (TPair<uint32, FCar>& Pair : Cars)
	{
		if (Pair.Value.Mesh)
		{
			vl_vehicle_mesh_destroy(Pair.Value.Mesh);
			Pair.Value.Mesh = nullptr;
		}
	}
	if (UVibeNetSubsystem* Net = NetFor(this))
	{
		Net->OnFrame.Remove(FrameHandle);
	}
	Super::EndPlay(EndPlayReason);
}

UMaterialInstanceDynamic* AVibeVehicles::MaterialFor(uint32 Rgba)
{
	if (TObjectPtr<UMaterialInstanceDynamic>* Found = Materials.Find(Rgba))
	{
		return *Found;
	}
	UMaterialInterface* Base = LoadObject<UMaterialInterface>(nullptr, TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
	UMaterialInstanceDynamic* M = UMaterialInstanceDynamic::Create(Base, this);
	M->SetVectorParameterValue(TEXT("Color"), FromRgba(Rgba));
	Materials.Add(Rgba, M);
	return M;
}

AVibeVehicles::FCar& AVibeVehicles::CarFor(uint32 Handle)
{
	if (FCar* Found = Cars.Find(Handle))
	{
		return *Found;
	}
	FCar& Car = Cars.Add(Handle);
	auto Scene = [this](USceneComponent* Parent, const FString& Name)
	{
		USceneComponent* C = NewObject<USceneComponent>(this, *Name);
		C->SetMobility(EComponentMobility::Movable);
		C->SetupAttachment(Parent);
		C->RegisterComponent();
		return C;
	};
	auto Mesh = [this](USceneComponent* Parent, const FString& Name)
	{
		UProceduralMeshComponent* C = NewObject<UProceduralMeshComponent>(this, *Name);
		C->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		C->SetMobility(EComponentMobility::Movable);
		C->SetupAttachment(Parent);
		C->RegisterComponent();
		return C;
	};
	Car.Root = Scene(RootComponent, FString::Printf(TEXT("Car%u"), Handle));
	Car.Chassis = Mesh(Car.Root, FString::Printf(TEXT("Car%uChassis"), Handle));
	for (int32 W = 0; W < 4; ++W)
	{
		Car.Hubs[W] = FVector::ZeroVector;
	}
	return Car;
}

void AVibeVehicles::OnFrame(const VlFrameView& Frame)
{
	for (size_t i = 0; i < Frame.event_count; ++i)
	{
		if (Frame.events[i].kind == VL_EVENT_VEHICLE_ASSET)
		{
			FCar& Car = CarFor(Frame.events[i].id);
			Car.bRequested = false; // a changed asset is fetched again
			RequestMesh(Frame.events[i].id);
		}
	}
	TSet<uint32> Present;
	for (size_t i = 0; i < Frame.car_count; ++i)
	{
		const VlCar& C = Frame.cars[i];
		Present.Add(C.handle);
		LastCars.Add(C.handle, C);
		FCar& Car = CarFor(C.handle);
		if (!Car.bRequested)
		{
			RequestMesh(C.handle);
		}
		Car.Root->SetWorldLocationAndRotation(FVector(C.pos[0], C.pos[1], C.pos[2]), FQuat(C.quat[0], C.quat[1], C.quat[2], C.quat[3]));
		Car.Root->SetVisibility(true, true);
		if ((C.flags & VL_CAR_HAS_WHEELS) && Car.bBuilt)
		{
			PoseRig(Car, C);
		}
	}
	for (TPair<uint32, FCar>& Pair : Cars)
	{
		if (!Present.Contains(Pair.Key) && Pair.Value.Root)
		{
			Pair.Value.Root->SetVisibility(false, true);
		}
	}

	// Parts off their cars: take them off the car's mesh when the set changes, draw each at its pose.
	TMap<uint32, TSet<uint32>> Off;
	for (size_t i = 0; i < Frame.car_part_count; ++i)
	{
		Off.FindOrAdd(Frame.car_parts[i].handle).Add(Frame.car_parts[i].part);
	}
	for (TPair<uint32, FCar>& Pair : Cars)
	{
		FCar& Car = Pair.Value;
		const TSet<uint32>* Now = Off.Find(Pair.Key);
		const TSet<uint32> Detached = Now ? *Now : TSet<uint32>();
		if (Car.bBuilt && (Detached.Num() != Car.Detached.Num() || !Detached.Includes(Car.Detached)))
		{
			Car.Detached = Detached;
			Rebuild(Pair.Key, Car);
			for (TPair<uint32, TObjectPtr<UProceduralMeshComponent>>& Loose : Car.Loose)
			{
				Loose.Value->SetVisibility(Car.Detached.Contains(Loose.Key));
			}
		}
	}
	for (size_t i = 0; i < Frame.car_part_count; ++i)
	{
		const VlCarPart& P = Frame.car_parts[i];
		FCar* Car = Cars.Find(P.handle);
		if (!Car || !Car->bBuilt)
		{
			continue;
		}
		UProceduralMeshComponent* C = LoosePart(P.handle, *Car, P.part);
		C->SetWorldLocationAndRotation(FVector(P.pos[0], P.pos[1], P.pos[2]), FQuat(P.quat[0], P.quat[1], P.quat[2], P.quat[3]));
		C->SetVisibility(true);
	}
}

int32 AVibeVehicles::LooseParts() const
{
	int32 Count = 0;
	for (const TPair<uint32, FCar>& Pair : Cars)
	{
		Count += Pair.Value.Detached.Num();
	}
	return Count;
}

void AVibeVehicles::RequestMesh(uint32 Handle)
{
	UVibeNetSubsystem* Net = NetFor(this);
	FCar& Car = CarFor(Handle);
	const FString Hash = Net ? Net->VehicleGeometryHash(Handle) : FString();
	if (Hash.IsEmpty() || (Car.bBuilt && Car.GeometryHash == Hash))
	{
		return; // the asset has not arrived yet, or this geometry is drawn
	}
	Car.bRequested = true;
	Car.GeometryHash = Hash;
	const FString Configuration = Net->VehicleConfiguration(Handle);
	const FString Url = FString::Printf(TEXT("%s/vehicle-assets/%s/metadata.json"), *Net->CurrentApiBaseUrl(), *Hash);
	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(Url);
	Request->SetVerb(TEXT("GET"));
	TWeakObjectPtr<AVibeVehicles> Weak(this);
	Request->OnProcessRequestComplete().BindLambda([Weak, Handle, Url, Configuration](FHttpRequestPtr, FHttpResponsePtr Response, bool bOk)
	{
		if (!bOk || !Response || Response->GetResponseCode() != 200)
		{
			UE_LOG(LogVibeLand, Warning, TEXT("car %u: %s failed (%d)"), Handle, *Url, Response ? Response->GetResponseCode() : -1);
			return;
		}
		TArray<uint8> Bytes = Response->GetContent();
		if (AVibeVehicles* Self = Weak.Get())
		{
			if (UVibeNetSubsystem* Net = NetFor(Self))
			{
				Net->SetVehicleMetadata(Handle, Bytes);
			}
		}
		// The core builds the hulls; ~a few hundred parts, so off the game thread.
		Async(EAsyncExecution::ThreadPool, [Weak, Handle, Bytes = MoveTemp(Bytes), Configuration]()
		{
			const FTCHARToUTF8 Config(*Configuration);
			VlVehicleMesh* Mesh = vl_vehicle_mesh_build(Bytes.GetData(), Bytes.Num(), Configuration.IsEmpty() ? nullptr : Config.Get(), 1);
			AsyncTask(ENamedThreads::GameThread, [Weak, Handle, Mesh]()
			{
				if (AVibeVehicles* Self = Weak.Get())
				{
					Self->ApplyMesh(Handle, Mesh);
				}
				else
				{
					vl_vehicle_mesh_destroy(Mesh);
				}
			});
		});
	});
	Request->ProcessRequest();
}

void AVibeVehicles::PoseRig(FCar& Car, const VlCar& C)
{
	if (!Car.Mesh || Car.Posed.Num() == 0)
	{
		return;
	}
	// The rig is a function of the four wheel states alone: unchanged wheels, unchanged parts.
	if (Car.bRigPosed && FMemory::Memcmp(Car.PosedWheels, C.wheels, sizeof(Car.PosedWheels)) == 0)
	{
		return;
	}
	FMemory::Memcpy(Car.PosedWheels, C.wheels, sizeof(Car.PosedWheels));
	Car.bRigPosed = true;
	++Car.RigPosings;
	const TArray<VlPartPose> Previous = Car.Poses;
	Car.Poses.SetNumZeroed(Car.Posed.Num(), EAllowShrinking::No);
	const int32 N = vl_vehicle_mesh_pose(Car.Mesh, C.wheels, Car.Poses.GetData(), Car.Poses.Num());
	for (int32 i = 0; i < FMath::Min(N, Car.PosedMeshes.Num()); ++i)
	{
		const VlPartPose& P = Car.Poses[i];
		// Moving a component dirties its render state: only parts whose pose changed (a steering
		// wheel or arm on the other axle may not have).
		if (Previous.IsValidIndex(i) && FMemory::Memcmp(&Previous[i], &P, sizeof(VlPartPose)) == 0)
		{
			continue;
		}
		Car.PosedMeshes[i]->SetRelativeTransform(PartTransform(P.pos, P.quat, P.scale));
	}
}

int32 AVibeVehicles::RigPosings(uint32 Handle) const
{
	const FCar* Car = Cars.Find(Handle);
	return Car ? Car->RigPosings : 0;
}

TPair<int32, int32> AVibeVehicles::PosedPartsMoved(uint32 Handle) const
{
	const FCar* Car = Cars.Find(Handle);
	if (!Car)
	{
		return {0, 0};
	}
	int32 Moved = 0;
	for (int32 i = 0; i < FMath::Min(Car->Posed.Num(), Car->PosedMeshes.Num()); ++i)
	{
		const VlPosedPart& R = Car->Posed[i];
		const FTransform Now = Car->PosedMeshes[i]->GetRelativeTransform();
		const FTransform Rest = PartTransform(R.rest_pos, R.rest_quat, R.rest_scale);
		if (FVector::Dist(Now.GetLocation(), Rest.GetLocation()) > 0.1 || Now.GetRotation().AngularDistance(Rest.GetRotation()) > FMath::DegreesToRadians(0.5))
		{
			++Moved;
		}
	}
	return {Moved, Car->Posed.Num()};
}

void AVibeVehicles::ApplyMesh(uint32 Handle, VlVehicleMesh* Mesh)
{
	if (!Mesh)
	{
		UE_LOG(LogVibeLand, Warning, TEXT("car %u: its metadata did not build a mesh"), Handle);
		return;
	}
	VlVehicleMeshView View;
	vl_vehicle_mesh_view(Mesh, &View);
	FCar& Car = CarFor(Handle);
	for (int32 W = 0; W < 4; ++W)
	{
		Car.Hubs[W] = FVector(View.hubs[W][0], View.hubs[W][1], View.hubs[W][2]);
	}
	Car.Vertices = TArray<VlVehicleVertex>(View.vertices, static_cast<int32>(View.vertex_count));
	Car.OriginHeight = View.origin_height;
	Car.Posed = TArray<VlPosedPart>(View.posed, static_cast<int32>(View.posed_count));
	for (int32 i = Car.PosedMeshes.Num(); i < Car.Posed.Num(); ++i)
	{
		UProceduralMeshComponent* C = NewObject<UProceduralMeshComponent>(this, *FString::Printf(TEXT("Car%uRig%d"), Handle, i));
		C->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		C->SetMobility(EComponentMobility::Movable);
		C->SetupAttachment(Car.Root);
		C->RegisterComponent();
		Car.PosedMeshes.Add(C);
	}
	for (int32 i = 0; i < Car.PosedMeshes.Num(); ++i)
	{
		Car.PosedMeshes[i]->SetVisibility(i < Car.Posed.Num());
		if (i < Car.Posed.Num())
		{
			const VlPosedPart& R = Car.Posed[i];
			Car.PosedMeshes[i]->SetRelativeTransform(PartTransform(R.rest_pos, R.rest_quat, R.rest_scale));
		}
	}
	if (Car.Mesh)
	{
		vl_vehicle_mesh_destroy(Car.Mesh);
	}
	Car.Mesh = Mesh;
	Car.bRigPosed = false; // a new mesh: pose its rig at the next wheel states
	Car.Poses.Reset();
	Rebuild(Handle, Car);
	Car.bBuilt = true;
	UE_LOG(LogVibeLand, Display, TEXT("car %u: built %zu triangles, %zu rig parts"), Handle, View.vertex_count / 3, View.posed_count);
}

void AVibeVehicles::Rebuild(uint32 Handle, FCar& Car)
{
	// Sort triangles into the components: the chassis (actor frame) and each posed part (in its own
	// rest frame, which the rig moves); parts off the car are left out (LoosePart draws them).
	TMap<uint32, int32> PosedIndex;
	TArray<FTransform> Rest;
	for (int32 i = 0; i < Car.Posed.Num(); ++i)
	{
		PosedIndex.Add(Car.Posed[i].part, i);
		Rest.Add(PartTransform(Car.Posed[i].rest_pos, Car.Posed[i].rest_quat, Car.Posed[i].rest_scale));
	}
	FSectionMesh Chassis;
	TArray<FSectionMesh> Parts;
	Parts.SetNum(Car.Posed.Num());
	for (int32 i = 0; i + 2 < Car.Vertices.Num(); i += 3)
	{
		if (Car.Detached.Contains(Car.Vertices[i].part))
		{
			continue;
		}
		const uint32 Color = Car.Vertices[i].color_rgba;
		const int32* Posed = Car.Vertices[i].section == VL_VEHICLE_SECTION_POSED ? PosedIndex.Find(Car.Vertices[i].part) : nullptr;
		FSectionMesh& S = Posed ? Parts[*Posed] : Chassis;
		for (int32 k = 0; k < 3; ++k)
		{
			const VlVehicleVertex& V = Car.Vertices[i + k];
			const FVector P(V.pos[0], V.pos[1], V.pos[2]);
			const FVector Nrm(V.normal[0], V.normal[1], V.normal[2]);
			if (Posed)
			{
				// Local to the rest frame; the normal by the inverse transpose (the scale, not its inverse).
				const FTransform& T = Rest[*Posed];
				S.Positions.FindOrAdd(Color).Add(T.InverseTransformPosition(P));
				S.Normals.FindOrAdd(Color).Add((T.GetRotation().UnrotateVector(Nrm) * T.GetScale3D()).GetSafeNormal());
			}
			else
			{
				S.Positions.FindOrAdd(Color).Add(P);
				S.Normals.FindOrAdd(Color).Add(Nrm);
			}
		}
	}
	auto Fill = [this](UProceduralMeshComponent* Component, FSectionMesh& S)
	{
		Component->ClearAllMeshSections();
		int32 Index = 0;
		for (TPair<uint32, TArray<FVector>>& Pair : S.Positions)
		{
			TArray<int32> Triangles;
			Triangles.Reserve(Pair.Value.Num());
			for (int32 t = 0; t < Pair.Value.Num(); ++t)
			{
				Triangles.Add(t);
			}
			Component->CreateMeshSection_LinearColor(Index, Pair.Value, Triangles, S.Normals[Pair.Key], {}, {}, {}, false);
			Component->SetMaterial(Index, MaterialFor(Pair.Key));
			++Index;
		}
	};
	Fill(Car.Chassis, Chassis);
	for (int32 i = 0; i < FMath::Min(Parts.Num(), Car.PosedMeshes.Num()); ++i)
	{
		Fill(Car.PosedMeshes[i], Parts[i]);
	}
}

UProceduralMeshComponent* AVibeVehicles::LoosePart(uint32 Handle, FCar& Car, uint32 Part)
{
	if (TObjectPtr<UProceduralMeshComponent>* Found = Car.Loose.Find(Part))
	{
		return *Found;
	}
	UProceduralMeshComponent* C = NewObject<UProceduralMeshComponent>(this, *FString::Printf(TEXT("Car%uPart%u"), Handle, Part));
	C->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	C->SetMobility(EComponentMobility::Movable);
	C->SetupAttachment(RootComponent);
	C->RegisterComponent();
	// The part in the asset's source frame (VlCarPart maps it to the world): actor + origin height.
	FSectionMesh S;
	const FVector Lift(0.0, 0.0, Car.OriginHeight);
	for (int32 i = 0; i + 2 < Car.Vertices.Num(); i += 3)
	{
		if (Car.Vertices[i].part != Part)
		{
			continue;
		}
		for (int32 k = 0; k < 3; ++k)
		{
			const VlVehicleVertex& V = Car.Vertices[i + k];
			S.Positions.FindOrAdd(V.color_rgba).Add(FVector(V.pos[0], V.pos[1], V.pos[2]) + Lift);
			S.Normals.FindOrAdd(V.color_rgba).Add(FVector(V.normal[0], V.normal[1], V.normal[2]));
		}
	}
	int32 Index = 0;
	for (TPair<uint32, TArray<FVector>>& Pair : S.Positions)
	{
		TArray<int32> Triangles;
		for (int32 t = 0; t < Pair.Value.Num(); ++t)
		{
			Triangles.Add(t);
		}
		C->CreateMeshSection_LinearColor(Index, Pair.Value, Triangles, S.Normals[Pair.Key], {}, {}, {}, false);
		C->SetMaterial(Index, MaterialFor(Pair.Key));
		++Index;
	}
	Car.Loose.Add(Part, C);
	return C;
}

TOptional<uint32> AVibeVehicles::NearestCar(const FVector& Position, double RadiusCm) const
{
	TOptional<uint32> Best;
	double BestDist = RadiusCm;
	for (const TPair<uint32, FCar>& Pair : Cars)
	{
		if (!Pair.Value.Root || !Pair.Value.Root->IsVisible())
		{
			continue;
		}
		const double D = FVector::Dist(Pair.Value.Root->GetComponentLocation(), Position);
		if (D <= BestDist)
		{
			BestDist = D;
			Best = Pair.Key;
		}
	}
	return Best;
}

TOptional<FVector> AVibeVehicles::CarPosition(uint32 Handle) const
{
	const FCar* Car = Cars.Find(Handle);
	return Car && Car->Root ? TOptional<FVector>(Car->Root->GetComponentLocation()) : TOptional<FVector>();
}

TOptional<FQuat> AVibeVehicles::CarRotation(uint32 Handle) const
{
	const FCar* Car = Cars.Find(Handle);
	return Car && Car->Root ? TOptional<FQuat>(Car->Root->GetComponentQuat()) : TOptional<FQuat>();
}

TOptional<FVector> AVibeVehicles::WheelPosition(uint32 Handle, int32 Wheel) const
{
	const FCar* Car = Cars.Find(Handle);
	return Car && Wheel >= 0 && Wheel < 4 && Car->Root ? TOptional<FVector>(Car->Root->GetComponentTransform().TransformPosition(Car->Hubs[Wheel])) : TOptional<FVector>();
}

TOptional<VlCar> AVibeVehicles::LastCar(uint32 Handle) const
{
	const VlCar* C = LastCars.Find(Handle);
	return C ? TOptional<VlCar>(*C) : TOptional<VlCar>();
}

int32 AVibeVehicles::BuiltCars() const
{
	int32 Built = 0;
	for (const TPair<uint32, FCar>& Pair : Cars)
	{
		Built += Pair.Value.bBuilt ? 1 : 0;
	}
	return Built;
}
