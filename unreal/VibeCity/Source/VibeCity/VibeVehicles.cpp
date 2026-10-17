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

	/** The triangles of one section, grouped by colour, relative to `Origin`. */
	struct FSectionMesh
	{
		TMap<uint32, TArray<FVector>> Positions;
		TMap<uint32, TArray<FVector>> Normals;
	};
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
		Car.Pivots[W] = Scene(Car.Root, FString::Printf(TEXT("Car%uPivot%d"), Handle, W));
		Car.Knuckles[W] = Mesh(Car.Pivots[W], FString::Printf(TEXT("Car%uKnuckle%d"), Handle, W));
		Car.Spinners[W] = Scene(Car.Pivots[W], FString::Printf(TEXT("Car%uSpin%d"), Handle, W));
		Car.Wheels[W] = Mesh(Car.Spinners[W], FString::Printf(TEXT("Car%uWheel%d"), Handle, W));
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
		if (C.flags & VL_CAR_HAS_WHEELS)
		{
			for (int32 W = 0; W < 4; ++W)
			{
				const VlWheel& Wheel = C.wheels[W];
				// Travel lifts the hub along the car's up; steer turns it about up. Unreal yaw is the
				// server's negated (coords.rs); spin is about the car's lateral axis (server X is
				// Unreal -Y), negated as the web's rig does.
				Car.Pivots[W]->SetRelativeLocationAndRotation(Car.Hubs[W] + FVector(0.0, 0.0, Wheel.travel),
					FRotator(0.0, -FMath::RadiansToDegrees(Wheel.steer), 0.0));
				Car.Spinners[W]->SetRelativeRotation(FRotator(FMath::RadiansToDegrees(Wheel.spin), 0.0, 0.0));
			}
		}
	}
	for (TPair<uint32, FCar>& Pair : Cars)
	{
		if (!Present.Contains(Pair.Key) && Pair.Value.Root)
		{
			Pair.Value.Root->SetVisibility(false, true);
		}
	}
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
		Car.Pivots[W]->SetRelativeLocation(Car.Hubs[W]);
	}
	// Sort triangles into the components: chassis (actor frame), knuckles and wheels (hub frame).
	FSectionMesh Sections[VL_VEHICLE_SECTIONS];
	for (size_t i = 0; i + 2 < View.vertex_count; i += 3)
	{
		const uint32 Section = FMath::Min(View.vertices[i].section, (uint32)VL_VEHICLE_SECTIONS - 1);
		const uint32 Color = View.vertices[i].color_rgba;
		const FVector Origin = Section == VL_VEHICLE_SECTION_CHASSIS ? FVector::ZeroVector
			: Car.Hubs[(Section - (Section >= VL_VEHICLE_SECTION_KNUCKLE ? VL_VEHICLE_SECTION_KNUCKLE : VL_VEHICLE_SECTION_WHEEL)) % 4];
		for (size_t k = 0; k < 3; ++k)
		{
			const VlVehicleVertex& V = View.vertices[i + k];
			Sections[Section].Positions.FindOrAdd(Color).Add(FVector(V.pos[0], V.pos[1], V.pos[2]) - Origin);
			Sections[Section].Normals.FindOrAdd(Color).Add(FVector(V.normal[0], V.normal[1], V.normal[2]));
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
	Fill(Car.Chassis, Sections[VL_VEHICLE_SECTION_CHASSIS]);
	for (int32 W = 0; W < 4; ++W)
	{
		Fill(Car.Wheels[W], Sections[VL_VEHICLE_SECTION_WHEEL + W]);
		Fill(Car.Knuckles[W], Sections[VL_VEHICLE_SECTION_KNUCKLE + W]);
	}
	Car.bBuilt = true;
	UE_LOG(LogVibeLand, Display, TEXT("car %u: built %zu triangles"), Handle, View.vertex_count / 3);
	vl_vehicle_mesh_destroy(Mesh);
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
	return Car && Wheel >= 0 && Wheel < 4 && Car->Spinners[Wheel] ? TOptional<FVector>(Car->Spinners[Wheel]->GetComponentLocation()) : TOptional<FVector>();
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
