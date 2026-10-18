#include "VibeCityCells.h"

#if WITH_EDITOR
#include "Engine/StaticMesh.h"
#include "MeshDescription.h"
#include "StaticMeshAttributes.h"
#endif

namespace VibeCityCells
{
	namespace
	{
		FVector ToVector(const float (&V)[3]) { return FVector(V[0], V[1], V[2]); }
	}

	FIntPoint CellKey(const FVector& RestPos)
	{
		return FIntPoint(FMath::FloorToInt(RestPos.X / CellSizeCm), FMath::FloorToInt(RestPos.Y / CellSizeCm));
	}

	FTransform RestTransform(const VlChunk& Chunk)
	{
		const FQuat Q = FQuat(Chunk.rest_quat[0], Chunk.rest_quat[1], Chunk.rest_quat[2], Chunk.rest_quat[3]).GetNormalized();
		return FTransform(Q, ToVector(Chunk.rest_pos));
	}

	FCatalogMap FCatalogMap::Build(bool bHd)
	{
		const VlMaterial* Catalog = nullptr;
		size_t Count = 0;
		vl_catalog(&Catalog, &Count);
		FCatalogMap Map;
		Map.LayerMetal.SetNum(static_cast<int32>(Count));
		Map.UvScale.SetNum(static_cast<int32>(Count));
		Map.Glass.SetNum(static_cast<int32>(Count));
		for (size_t i = 0; i < Count; ++i)
		{
			Map.UvScale[i] = bHd && Catalog[i].hd_metres_per_tile > 0.0f ? Catalog[i].metres_per_tile / Catalog[i].hd_metres_per_tile : 1.0f;
			Map.LayerMetal[i] = FVector2D(FMath::Max(Catalog[i].layer, 0), Catalog[i].metalness);
			Map.Glass[i] = (Catalog[i].flags & VL_MATERIAL_GLASS) != 0;
		}
		return Map;
	}

	void AppendChunk(const VlMeshView& M, int32 ChunkIndex, const FTransform& ToComponent, const FTransform& Rest, const FCatalogMap& Catalog,
		FSection& Opaque, FSection& Glass)
	{
		if (ChunkIndex < 0 || static_cast<size_t>(ChunkIndex) >= M.range_count)
		{
			return;
		}
		const VlMeshRange& R = M.ranges[ChunkIndex];
		// One material per triangle (the core assigns it per face): route each triangle by its first
		// vertex's material.
		for (uint32 t = 0; t + 2 < R.index_count; t += 3)
		{
			const uint32 First = R.first_vertex + M.indices[R.first_index + t];
			const int32 Material = static_cast<int32>(M.materials[First]);
			const bool bGlass = Catalog.Glass.IsValidIndex(Material) && Catalog.Glass[Material];
			FSection& S = bGlass ? Glass : Opaque;
			const FVector2D LayerMetal = Catalog.LayerMetal.IsValidIndex(Material) ? Catalog.LayerMetal[Material] : FVector2D::ZeroVector;
			const double UvScale = Catalog.UvScale.IsValidIndex(Material) ? Catalog.UvScale[Material] : 1.0;
			for (uint32 k = 0; k < 3; ++k)
			{
				const uint32 V = R.first_vertex + M.indices[R.first_index + t + k];
				S.Triangles.Add(S.Vertices.Num());
				S.Vertices.Add(ToComponent.TransformPosition(ToVector(M.positions[V])));
				S.Normals.Add(ToComponent.TransformVectorNoScale(ToVector(M.normals[V])));
				const float(&Tg)[4] = M.tangents[V];
				// Unreal derives the binormal as normal x tangent, flipped when bFlipTangentY; the core's
				// w is +1 when normal x tangent already points along +v.
				S.Tangents.Add(FProcMeshTangent(ToComponent.TransformVectorNoScale(FVector(Tg[0], Tg[1], Tg[2])), Tg[3] < 0.0f));
				S.UV0.Add(FVector2D(M.tile_uvs[V][0], M.tile_uvs[V][1]) * UvScale);
				S.UV1.Add(LayerMetal);
				// Height in metres only: Nanite quantises UVs over each cluster's range, and wide ranges
				// (city coordinates) cost the layer index in UV1 its precision.
				const double Height = Rest.TransformPosition(ToVector(M.positions[V])).Z / 100.0;
				S.UV2.Add(FVector2D(Height, M.interior ? static_cast<double>(M.interior[V]) : 0.0));
			}
		}
	}

#if WITH_EDITOR
	UStaticMesh* BuildStaticMesh(UObject* Outer, FName Name, const FSection& S, bool bNanite, EObjectFlags Flags)
	{
		UStaticMesh* Mesh = NewObject<UStaticMesh>(Outer, Name, Flags);
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
		return Mesh;
	}
#endif

	FString SceneFolder(const FString& ManifestHash, bool bHd)
	{
		return FString::Printf(TEXT("/Game/VibeCity/Scenes/%s_%s"), *ManifestHash.Left(16), bHd ? TEXT("HD") : TEXT("Web"));
	}

	FString CellAssetName(FIntPoint Key, bool bGlass)
	{
		return FString::Printf(TEXT("Cell_%d_%d%s"), Key.X, Key.Y, bGlass ? TEXT("_Glass") : TEXT(""));
	}
}
