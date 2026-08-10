use anyhow::{bail, Context, Result};
use vibe_netcode::physics_backend::{
    PhysicsBackendKind, PhysicsCapabilities, CLIENT_MOVEMENT_FULL_PREDICTION,
    CLIENT_MOVEMENT_THIN_AUTHORITATIVE,
};

use vibe_land_shared::constants::{SIM_HZ, SNAPSHOT_HZ_MULTIPLAYER};

pub const PHYSX_SNAPSHOT_HZ: u16 = 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PhysicsRuntimeConfig {
    pub backend: PhysicsBackendKind,
    pub capabilities: PhysicsCapabilities,
}

impl PhysicsRuntimeConfig {
    pub fn from_env() -> Result<Self> {
        let raw = std::env::var("VIBE_PHYSICS_BACKEND").unwrap_or_else(|_| "rapier".to_string());
        Self::parse(&raw)
    }

    pub fn parse(value: &str) -> Result<Self> {
        let backend = PhysicsBackendKind::parse(value)
            .map_err(anyhow::Error::msg)
            .context("invalid VIBE_PHYSICS_BACKEND")?;
        let capabilities = match backend {
            PhysicsBackendKind::Rapier => PhysicsCapabilities::rapier(SNAPSHOT_HZ_MULTIPLAYER),
            PhysicsBackendKind::PhysxGpu => {
                if !cfg!(feature = "physx-gpu") {
                    bail!(
                        "VIBE_PHYSICS_BACKEND=physx_gpu requires building web-fps-server with --features physx-gpu"
                    );
                }
                PhysicsCapabilities::physx_gpu(PHYSX_SNAPSHOT_HZ)
            }
        };
        Ok(Self {
            backend,
            capabilities,
        })
    }

    pub const fn sim_hz(self) -> u16 {
        SIM_HZ
    }

    pub const fn snapshot_hz(self) -> u16 {
        self.capabilities.snapshot_hz
    }

    pub const fn interpolation_delay_ms(self) -> u16 {
        let frame_ms = 1000 / self.snapshot_hz();
        frame_ms * 2
    }

    pub const fn client_movement_mode(self) -> u8 {
        match self.backend {
            PhysicsBackendKind::Rapier => CLIENT_MOVEMENT_FULL_PREDICTION,
            PhysicsBackendKind::PhysxGpu => CLIENT_MOVEMENT_THIN_AUTHORITATIVE,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rapier_preserves_existing_snapshot_policy() {
        let config = PhysicsRuntimeConfig::parse("rapier").unwrap();
        assert_eq!(config.snapshot_hz(), SNAPSHOT_HZ_MULTIPLAYER);
        assert_eq!(
            config.client_movement_mode(),
            CLIENT_MOVEMENT_FULL_PREDICTION
        );
    }

    #[test]
    fn invalid_backend_is_rejected() {
        assert!(PhysicsRuntimeConfig::parse("bullet").is_err());
    }

    #[cfg(feature = "physx-gpu")]
    #[test]
    fn physx_requires_thin_movement_and_sixty_hz_snapshots() {
        let config = PhysicsRuntimeConfig::parse("physx_gpu").unwrap();
        assert_eq!(config.snapshot_hz(), 60);
        assert_eq!(
            config.client_movement_mode(),
            CLIENT_MOVEMENT_THIN_AUTHORITATIVE
        );
        assert!(config.capabilities.gpu_required);
    }
}
