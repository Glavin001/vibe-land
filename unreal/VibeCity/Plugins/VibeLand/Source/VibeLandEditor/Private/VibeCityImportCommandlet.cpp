#include "VibeCityImportCommandlet.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Engine/StaticMesh.h"
#include "MeshDescription.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "Misc/Parse.h"
#include "StaticMeshAttributes.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"
#include "VibeCityCells.h"
#include "vibe_client_core.h"

DEFINE_LOG_CATEGORY_STATIC(LogVibeCityImport, Log, All);

namespace
{
	/** A static mesh holding one section (no welding: each triangle keeps its own corners, as the
	 * runtime mesh does), saved as `Folder/Name`. */
	bool SaveSection(const FString& Folder, const FString& Name, const VibeCityCells::FSection& S, bool bNanite)
	{
		const FString PackageName = Folder / Name;
		UPackage* Package = CreatePackage(*PackageName);
		Package->FullyLoad();
		UStaticMesh* Mesh = NewObject<UStaticMesh>(Package, *Name, RF_Public | RF_Standalone);

		FMeshDescription Description;
		FStaticMeshAttributes Attributes(Description);
		Attributes.Register();
		Attributes.GetVertexInstanceUVs().SetNumChannels(3);
		const FPolygonGroupID Group = Description.CreatePolygonGroup();
		Attributes.GetPolygonGroupMaterialSlotNames()[Group] = TEXT("Chunk");
		TVertexAttributesRef<FVector3f> Positions = Attributes.GetVertexPositions();
		TVertexInstanceAttributesRef<FVector3f> Normals = Attributes.GetVertexInstanceNormals();
		TVertexInstanceAttributesRef<FVector3f> Tangents = Attributes.GetVertexInstanceTangents();
		TVertexInstanceAttributesRef<float> Signs = Attributes.GetVertexInstanceBinormalSigns();
		TVertexInstanceAttributesRef<FVector2f> UVs = Attributes.GetVertexInstanceUVs();
		Description.ReserveNewVertices(S.Vertices.Num());
		Description.ReserveNewVertexInstances(S.Vertices.Num());
		Description.ReserveNewTriangles(S.Triangles.Num() / 3);
		for (int32 t = 0; t + 2 < S.Triangles.Num(); t += 3)
		{
			TArray<FVertexInstanceID, TFixedAllocator<3>> Corners;
			for (int32 k = 0; k < 3; ++k)
			{
				const int32 V = S.Triangles[t + k];
				const FVertexID Vertex = Description.CreateVertex();
				Positions[Vertex] = FVector3f(S.Vertices[V]);
				const FVertexInstanceID Instance = Description.CreateVertexInstance(Vertex);
				Normals[Instance] = FVector3f(S.Normals[V]);
				Tangents[Instance] = FVector3f(S.Tangents[V].TangentX);
				// As the procedural mesh reads FProcMeshTangent: binormal = normal x tangent, flipped
				// when bFlipTangentY.
				Signs[Instance] = S.Tangents[V].bFlipTangentY ? -1.0f : 1.0f;
				UVs.Set(Instance, 0, FVector2f(S.UV0[V]));
				UVs.Set(Instance, 1, FVector2f(S.UV1[V]));
				UVs.Set(Instance, 2, FVector2f(S.UV2[V]));
				Corners.Add(Instance);
			}
			Description.CreateTriangle(Group, Corners);
		}

		Mesh->GetStaticMaterials().Add(FStaticMaterial(nullptr, TEXT("Chunk"), TEXT("Chunk")));
		FStaticMeshSourceModel& Source = Mesh->AddSourceModel();
		Source.BuildSettings.bRecomputeNormals = false;
		Source.BuildSettings.bRecomputeTangents = false;
		Source.BuildSettings.bGenerateLightmapUVs = false;
		Source.BuildSettings.bRemoveDegenerates = false;
		Source.BuildSettings.bUseFullPrecisionUVs = true;
		Mesh->NaniteSettings.bEnabled = bNanite;
		// UV1 holds each face's texture-array layer: an index, not interpolable.
		Mesh->NaniteSettings.bLerpUVs = false;
		Mesh->NaniteSettings.bExplicitTangents = true;
		Mesh->bGenerateMeshDistanceField = true;
		Mesh->CreateMeshDescription(0, MoveTemp(Description));
		Mesh->CommitMeshDescription(0);
		Mesh->Build(/*bInSilent=*/true);
		Mesh->MarkPackageDirty();
		FAssetRegistryModule::AssetCreated(Mesh);

		const FString File = FPackageName::LongPackageNameToFilename(PackageName, FPackageName::GetAssetPackageExtension());
		FSavePackageArgs Args;
		Args.TopLevelFlags = RF_Public | RF_Standalone;
		Args.Error = GError;
		return UPackage::SavePackage(Package, Mesh, *File, Args);
	}
}

UVibeCityImportCommandlet::UVibeCityImportCommandlet()
{
	IsClient = false;
	IsEditor = true;
	IsServer = false;
	LogToConsole = true;
}

int32 UVibeCityImportCommandlet::Main(const FString& Params)
{
	FString ManifestPath;
	if (!FParse::Value(*Params, TEXT("Manifest="), ManifestPath))
	{
		UE_LOG(LogVibeCityImport, Error, TEXT("-Manifest=<file> is required (an uncompressed city manifest)"));
		return 1;
	}
	const bool bHd = !FParse::Param(*Params, TEXT("Web"));
	TArray<uint8> Bytes;
	if (!FFileHelper::LoadFileToArray(Bytes, *ManifestPath))
	{
		UE_LOG(LogVibeCityImport, Error, TEXT("cannot read %s"), *ManifestPath);
		return 1;
	}
	VlCity* City = vl_city_build(Bytes.GetData(), Bytes.Num(), 1 /* Unreal space */);
	if (!City)
	{
		UE_LOG(LogVibeCityImport, Error, TEXT("%s is not a city manifest"), *ManifestPath);
		return 1;
	}
	ANSICHAR HashBuffer[80] = {};
	vl_city_hash(City, HashBuffer, sizeof(HashBuffer));
	const FString Hash = UTF8_TO_TCHAR(HashBuffer);
	const VlChunk* Chunks = nullptr;
	size_t ChunkCount = 0;
	VlMeshView Meshes = {};
	vl_city_chunks(City, &Chunks, &ChunkCount);
	vl_city_meshes(City, &Meshes);

	// Chunks per cell, in chunk-table order, as the director groups them.
	TMap<FIntPoint, TArray<int32>> Cells;
	for (size_t i = 0; i < ChunkCount; ++i)
	{
		Cells.FindOrAdd(VibeCityCells::CellKey(VibeCityCells::RestTransform(Chunks[i]).GetLocation())).Add(static_cast<int32>(i));
	}
	const VibeCityCells::FCatalogMap Catalog = VibeCityCells::FCatalogMap::Build(bHd);
	const FString Folder = VibeCityCells::SceneFolder(Hash, bHd);
	UE_LOG(LogVibeCityImport, Display, TEXT("city %s: %llu chunks in %d cells -> %s"), *Hash, static_cast<unsigned long long>(ChunkCount), Cells.Num(), *Folder);
	const double Started = FPlatformTime::Seconds();
	int32 Saved = 0, Failed = 0;
	int64 Triangles = 0;
	for (const TPair<FIntPoint, TArray<int32>>& Cell : Cells)
	{
		VibeCityCells::FSection Opaque, Glass;
		for (const int32 Index : Cell.Value)
		{
			VibeCityCells::AppendChunk(Meshes, Index, VibeCityCells::RestTransform(Chunks[Index]), VibeCityCells::RestTransform(Chunks[Index]), Catalog, Opaque, Glass);
		}
		Triangles += (Opaque.Triangles.Num() + Glass.Triangles.Num()) / 3;
		if (Opaque.Vertices.Num() > 0)
		{
			(SaveSection(Folder, VibeCityCells::CellAssetName(Cell.Key, false), Opaque, true) ? Saved : Failed) += 1;
		}
		if (Glass.Vertices.Num() > 0)
		{
			(SaveSection(Folder, VibeCityCells::CellAssetName(Cell.Key, true), Glass, false) ? Saved : Failed) += 1;
		}
	}
	vl_city_destroy(City);
	UE_LOG(LogVibeCityImport, Display, TEXT("imported %d meshes (%lld triangles) in %.1f s; %d failed"), Saved, Triangles, FPlatformTime::Seconds() - Started, Failed);
	return Failed == 0 && Saved > 0 ? 0 : 1;
}
