use std::fs;
use std::io::{self, Read, Write};

use crate::snapshot::FileEntry;

const TAR_BLOCK_SIZE: usize = 512;

fn split_ustar_path(path: &str) -> Option<(&str, &str)> {
    let path = path.trim_start_matches("./").trim_end_matches('/');
    if path.is_empty() {
        return None;
    }

    if path.as_bytes().len() <= 100 {
        return Some(("", path));
    }

    for (index, _) in path.match_indices('/').rev() {
        let prefix = &path[..index];
        let name = &path[index + 1..];
        if !name.is_empty() && prefix.as_bytes().len() <= 155 && name.as_bytes().len() <= 100 {
            return Some((prefix, name));
        }
    }

    None
}

fn write_octal_field(header: &mut [u8], start: usize, len: usize, value: u64) -> io::Result<()> {
    if len == 0 {
        return Ok(());
    }

    let digits_len = len.saturating_sub(1);
    let value_text = format!("{value:0digits_len$o}");
    if value_text.len() > digits_len {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "tar header numeric field is too large",
        ));
    }

    let field = &mut header[start..start + len];
    field.fill(b'0');
    let offset = digits_len - value_text.len();
    field[offset..offset + value_text.len()].copy_from_slice(value_text.as_bytes());
    field[len - 1] = 0;
    Ok(())
}

fn write_ustar_header<W: Write>(
    writer: &mut W,
    relative_path: &str,
    size: u64,
    mode: u32,
    mtime_seconds: u64,
    entry_type: u8,
) -> io::Result<()> {
    let (prefix, name) = split_ustar_path(relative_path).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("tar path is too long for ustar header: {relative_path}"),
        )
    })?;
    let mut header = [0_u8; TAR_BLOCK_SIZE];
    header[0..name.len()].copy_from_slice(name.as_bytes());
    write_octal_field(&mut header, 100, 8, u64::from(mode))?;
    write_octal_field(&mut header, 108, 8, 0)?;
    write_octal_field(&mut header, 116, 8, 0)?;
    write_octal_field(&mut header, 124, 12, size)?;
    write_octal_field(&mut header, 136, 12, mtime_seconds)?;
    header[148..156].fill(b' ');
    header[156] = entry_type;
    header[257..263].copy_from_slice(b"ustar\0");
    header[263..265].copy_from_slice(b"00");
    if !prefix.is_empty() {
        header[345..345 + prefix.len()].copy_from_slice(prefix.as_bytes());
    }

    let checksum = header.iter().map(|byte| u32::from(*byte)).sum::<u32>();
    let checksum_text = format!("{checksum:06o}");
    header[148..154].copy_from_slice(checksum_text.as_bytes());
    header[154] = 0;
    header[155] = b' ';
    writer.write_all(&header)
}

fn write_padding<W: Write>(writer: &mut W, size: u64) -> io::Result<()> {
    let remainder = (size as usize) % TAR_BLOCK_SIZE;
    if remainder == 0 {
        return Ok(());
    }

    let padding = [0_u8; TAR_BLOCK_SIZE];
    writer.write_all(&padding[..TAR_BLOCK_SIZE - remainder])
}

pub(crate) fn write_snapshot_ustar_archive<W: Write>(
    mut writer: W,
    file_entries: &[FileEntry],
    empty_directories: &[String],
) -> io::Result<W> {
    let mut buffer = [0_u8; 64 * 1024];
    for file in file_entries {
        write_ustar_header(
            &mut writer,
            &file.relative_path,
            file.size,
            file.mode,
            (file.mtime_ms / 1000).min(u128::from(u64::MAX)) as u64,
            b'0',
        )?;
        let mut source = fs::File::open(&file.absolute_path)?;
        loop {
            let read = source.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            writer.write_all(&buffer[..read])?;
        }
        write_padding(&mut writer, file.size)?;
    }

    for relative_path in empty_directories {
        let directory_path = format!("{}/", relative_path.trim_end_matches('/'));
        write_ustar_header(&mut writer, &directory_path, 0, 0o755, 0, b'5')?;
    }

    writer.write_all(&[0_u8; TAR_BLOCK_SIZE])?;
    writer.write_all(&[0_u8; TAR_BLOCK_SIZE])?;
    Ok(writer)
}
