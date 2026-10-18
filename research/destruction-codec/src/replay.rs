//! Writer for the `TWSTATE1` format consumed by:
//! `tower-demo render --state reconstructed.towerstate --output replay.mp4`.

use std::{
    fs::File,
    io::{BufWriter, Write},
    path::Path,
};

use anyhow::{ensure, Context, Result};

use crate::trace::{
    write_f32, write_pose, write_u32, write_u8, write_vec3, ActorDef, Camera, Header, Pose,
};

pub struct ReplayWriter {
    writer: BufWriter<File>,
    actor_count: usize,
    frame_count: u32,
    written: u32,
}

impl ReplayWriter {
    pub fn create(
        path: &Path,
        trace: &Header,
        actors: &[ActorDef],
        output_fps: u32,
    ) -> Result<Self> {
        ensure!(output_fps > 0);
        let frame_count = if trace.tick_count == 0 {
            0
        } else {
            (trace.tick_count - 1)
                .saturating_mul(output_fps)
                .checked_div(trace.physics_hz)
                .unwrap_or(0)
                + 1
        };
        let mut writer = BufWriter::new(
            File::create(path).with_context(|| format!("create replay {}", path.display()))?,
        );
        writer.write_all(b"TWSTATE1")?;
        write_u32(&mut writer, 1)?;
        write_u32(&mut writer, output_fps)?;
        write_u32(&mut writer, frame_count)?;
        write_u32(&mut writer, trace.pane_width)?;
        write_u32(&mut writer, trace.pane_height)?;
        write_u32(&mut writer, 1)?; // informational building count
        write_u32(&mut writer, 4)?;
        write_f32(
            &mut writer,
            trace.tick_count as f32 / trace.physics_hz as f32,
        )?;
        write_f32(&mut writer, 0.0)?;
        for camera in &trace.cameras {
            write_vec3(&mut writer, camera.eye)?;
            write_vec3(&mut writer, camera.direction)?;
            write_f32(&mut writer, camera.fov_degrees)?;
        }
        for actor in actors {
            write_u8(&mut writer, 1)?;
            write_u32(&mut writer, actor.id)?;
            write_u8(&mut writer, actor.part)?;
            write_u32(&mut writer, actor.shapes.len() as u32)?;
            for shape in &actor.shapes {
                write_u8(&mut writer, shape.kind)?;
                write_vec3(&mut writer, shape.params)?;
                write_pose(&mut writer, shape.local)?;
            }
        }
        Ok(Self {
            writer,
            actor_count: actors.len(),
            frame_count,
            written: 0,
        })
    }

    /// Moves the viewpoint for every following frame. Written before the frame
    /// it applies to; a recording without any of these renders exactly as
    /// before, from the header's four fixed cameras.
    pub fn write_cameras(&mut self, cameras: &[Camera; 4]) -> Result<()> {
        write_u8(&mut self.writer, 3)?;
        for camera in cameras {
            write_vec3(&mut self.writer, camera.eye)?;
            write_vec3(&mut self.writer, camera.direction)?;
            write_f32(&mut self.writer, camera.fov_degrees)?;
        }
        Ok(())
    }

    /// Writes only the bodies named, leaving every other actor untouched.
    ///
    /// This is how a viewer's own recording is made honest: a body the viewer
    /// has no subscribed source for is simply never written, so it never
    /// becomes visible in the render. Missing coverage looks like missing
    /// geometry, which is what it is.
    pub fn write_frame_subset(&mut self, updates: &[(u32, Pose, bool)]) -> Result<()> {
        write_u8(&mut self.writer, 2)?;
        write_u32(&mut self.writer, self.written)?;
        write_u32(&mut self.writer, updates.len() as u32)?;
        for (id, pose, sleeping) in updates {
            write_u32(&mut self.writer, *id)?;
            write_pose(&mut self.writer, *pose)?;
            write_u8(&mut self.writer, u8::from(*sleeping))?;
        }
        self.written += 1;
        Ok(())
    }

    pub fn write_frame(&mut self, poses: &[Pose], sleeping: &[bool]) -> Result<()> {
        ensure!(poses.len() == self.actor_count && sleeping.len() == self.actor_count);
        write_u8(&mut self.writer, 2)?;
        write_u32(&mut self.writer, self.written)?;
        write_u32(&mut self.writer, self.actor_count as u32)?;
        for (id, (pose, sleeping)) in poses.iter().zip(sleeping).enumerate() {
            write_u32(&mut self.writer, id as u32)?;
            write_pose(&mut self.writer, *pose)?;
            write_u8(&mut self.writer, u8::from(*sleeping))?;
        }
        self.written += 1;
        Ok(())
    }

    pub fn finish(mut self) -> Result<()> {
        ensure!(
            self.written == self.frame_count,
            "replay frame mismatch: wrote {}, expected {}",
            self.written,
            self.frame_count
        );
        write_u8(&mut self.writer, 255)?;
        self.writer.flush()?;
        Ok(())
    }
}
