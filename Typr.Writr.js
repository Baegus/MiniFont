var Typr = Typr || {};

Typr.Writer = (function() {
	
	function write(font, chars) {
		// Identify Glyphs
		// Always include .notdef (0)
		var glyphs = [0];
		var charToGlyph = {};
		var old2new = {0:0};
		
		// Collect requested glyphs
		for(var i=0; i<chars.length; i++) {
			var code = chars.codePointAt(i);
			if(code>0xffff) i++;
			var gid = Typr.U.codeToGlyph(font, code);
			if(gid != 0) {
				if(old2new[gid] == null) {
					old2new[gid] = glyphs.length;
					glyphs.push(gid);
				}
				charToGlyph[code] = old2new[gid];
			}
		}
		
		// Add dependencies (composite glyphs)
		// We need to iterate until no new glyphs are added
		var ptr = 0;
		while(ptr < glyphs.length) {
			var gid = glyphs[ptr++];
			var gl = font.glyf[gid];
			if(!gl && Typr.T.glyf._parseGlyf) gl = font.glyf[gid] = Typr.T.glyf._parseGlyf(font, gid);
			
			if(!gl || !gl.parts) continue;

			for(var i=0; i<gl.parts.length; i++) {
				var compGid = gl.parts[i].glyphIndex;
				if(old2new[compGid] == null) {
					old2new[compGid] = glyphs.length;
					glyphs.push(compGid);
				}
			}
		}
		
		// Build Tables
		var tables = {};
		
		// Head
		tables.head = copyTable(font, "head");
		tables.head.setUint16(50, 0); // indexToLocFormat (will be set later)
		
		// Hhea
		tables.hhea = copyTable(font, "hhea");
		tables.hhea.setUint16(34, glyphs.length); // numberOfHMetrics
		
		// Maxp
		tables.maxp = copyTable(font, "maxp");
		tables.maxp.setUint16(4, glyphs.length); // numGlyphs
		
		// OS/2, name - Copy as is
		tables["OS/2"] = copyTable(font, "OS/2");
		tables.name = copyTable(font, "name");
		
		// Hinting tables - Copy if they exist to preserve hinting
		var hintingTables = ["cvt ", "fpgm", "prep", "gasp"];
		for(var i=0; i<hintingTables.length; i++) {
			var t = copyTable(font, hintingTables[i]);
			if(t) tables[hintingTables[i]] = t;
		}
		
		// Post - Create new version 3.0 table
		tables.post = createPost(font);
		
		// Hmtx
		tables.hmtx = createHmtx(font, glyphs);
		
		// Glyf & Loca
		var glResult = createGlyf(font, glyphs, old2new);
		tables.glyf = glResult.glyf;
		tables.loca = glResult.loca;
		if(glResult.isLongLoca) {
			tables.head.setUint16(50, 1); // indexToLocFormat = 1 (long)
		} else {
			tables.head.setUint16(50, 0); // indexToLocFormat = 0 (short)
		}
		
		// Cmap
		tables.cmap = createCmap(charToGlyph);
		
		// Assemble
		return createFont(tables);
	}
	
	function copyTable(font, name) {
		// We need the raw bytes. Typr stores offsets in font._data
		// But font[name] is the parsed object.
		// We need to find the table entry in the directory.
		var data = font._data;
		var offset = Typr.findTable(data, name, font._offset);
		if(!offset) return null;
		
		var off = offset[0];
		var len = offset[1];
		
		var buf = new Uint8Array(len);
		for(var i=0; i<len; i++) buf[i] = data[off+i];
		return new DataView(buf.buffer);
	}
	
	function createHmtx(font, glyphs) {
		var len = glyphs.length * 4;
		var buf = new ArrayBuffer(len);
		var view = new DataView(buf);
		
		for(var i=0; i<glyphs.length; i++) {
			var gid = glyphs[i];
			var aw = font.hmtx.aWidth[gid];
			var lsb = font.hmtx.lsBearing[gid];
			view.setUint16(i*4, aw);
			view.setInt16(i*4+2, lsb);
		}
		return view;
	}
	
	function createGlyf(font, glyphs, old2new) {
		// First pass: calculate size
		var size = 0;
		var loca = [];
		var glyfParts = [];
		
		for(var i=0; i<glyphs.length; i++) {
			loca.push(size);
			var gid = glyphs[i];
			var gl = font.glyf[gid];
			
			if(!gl) {
				// Empty glyph
				glyfParts.push(new Uint8Array(0));
				continue;
			}
			
			// We need to reconstruct the glyph bytes
			// Typr parses glyf into objects, we need to serialize them back OR copy raw bytes and patch indices.
			// Copying raw bytes is safer but we MUST patch composite glyph indices.
			
			var data = font._data;
			var offset = Typr.findTable(data, "glyf", font._offset)[0] + font.loca[gid];
			var len = font.loca[gid+1] - font.loca[gid];
			
			if(len == 0) {
				glyfParts.push(new Uint8Array(0));
				continue;
			}
			
			var bytes = new Uint8Array(len);
			for(var j=0; j<len; j++) bytes[j] = data[offset+j];
			
			// Check if composite
			var numberOfContours = (bytes[0]<<8) | bytes[1];
			// Convert to signed 16-bit
			numberOfContours = (numberOfContours << 16) >> 16;
			
			if(numberOfContours < 0) {
				// Composite
				// We need to parse flags to find glyph indices and update them
				var pos = 10; // Header size
				var flags = 0;
				do {
					flags = (bytes[pos]<<8) | bytes[pos+1];
					var glyphIndex = (bytes[pos+2]<<8) | bytes[pos+3];
					
					// Update glyph index
					var newGid = old2new[glyphIndex];
					if(newGid === undefined) newGid = 0; // Should not happen if we added dependencies
					
					bytes[pos+2] = (newGid>>8)&0xff;
					bytes[pos+3] = newGid&0xff;
					
					pos += 4;
					
					var ARG_1_AND_2_ARE_WORDS = 1<<0;
					var ARGS_ARE_XY_VALUES = 1<<1;
					var WE_HAVE_A_SCALE = 1<<3;
					var MORE_COMPONENTS = 1<<5;
					var WE_HAVE_AN_X_AND_Y_SCALE = 1<<6;
					var WE_HAVE_A_TWO_BY_TWO = 1<<7;
					
					if(flags & ARG_1_AND_2_ARE_WORDS) pos += 4;
					else pos += 2;
					
					if(flags & WE_HAVE_A_SCALE) pos += 2;
					else if(flags & WE_HAVE_AN_X_AND_Y_SCALE) pos += 4;
					else if(flags & WE_HAVE_A_TWO_BY_TWO) pos += 8;
					
				} while(flags & MORE_COMPONENTS);
			}
			
			glyfParts.push(bytes);
			size += len;
			
			// Padding for 2-byte alignment (loca format 0 requires it, but format 1 doesn't strictly, but good practice)
			// Actually loca format 0 stores offset/2, so offsets must be even.
			if(size % 2 != 0) {
				size++;
				// We'll handle padding during concatenation
			}
		}
		loca.push(size);
		
		// Determine loca format
		var isLongLoca = size > 131070; // 0xFFFF * 2
		
		// Create glyf buffer
		var glyfBuf = new Uint8Array(size);
		var ptr = 0;
		for(var i=0; i<glyfParts.length; i++) {
			var part = glyfParts[i];
			glyfBuf.set(part, ptr);
			ptr += part.length;
			if(ptr % 2 != 0) ptr++; // Padding
		}
		
		// Create loca buffer
		var locaBuf;
		if(isLongLoca) {
			locaBuf = new ArrayBuffer(loca.length * 4);
			var view = new DataView(locaBuf);
			for(var i=0; i<loca.length; i++) view.setUint32(i*4, loca[i]);
		} else {
			locaBuf = new ArrayBuffer(loca.length * 2);
			var view = new DataView(locaBuf);
			for(var i=0; i<loca.length; i++) view.setUint16(i*2, loca[i]/2);
		}
		
		return {
			glyf: new DataView(glyfBuf.buffer),
			loca: new DataView(locaBuf),
			isLongLoca: isLongLoca
		};
	}
	
	function createCmap(charToGlyph) {
		// We'll create a Format 4 cmap (standard for Windows/Web)
		// Format 12 is needed for chars > 0xFFFF, but let's start with Format 4 support.
		// If we have chars > 0xFFFF, we should use Format 12.
		
		var chars = Object.keys(charToGlyph).map(Number).sort(function(a,b){return a-b});
		
		// Check if we need Format 12
		var useFormat12 = chars.length > 0 && chars[chars.length-1] > 0xFFFF;
		
		if(useFormat12) {
			return createCmapFormat12(chars, charToGlyph);
		} else {
			return createCmapFormat4(chars, charToGlyph);
		}
	}
	
	function createCmapFormat4(chars, charToGlyph) {
		var segCount = 0;
		var startCount = [];
		var endCount = [];
		var idDelta = [];
		var idRangeOffset = [];
		
		if(chars.length > 0) {
			var start = chars[0];
			var end = chars[0];
			var lastGid = charToGlyph[start];
			
			// Simple segmentation: continuous ranges where delta is constant
			// One segment per contiguous range of characters.
			
			for(var i=1; i<chars.length; i++) {
				var c = chars[i];
				var gid = charToGlyph[c];
				var prevC = chars[i-1];
				var prevGid = charToGlyph[prevC];
				
				if(c == prevC + 1 && gid == prevGid + 1) {
					end = c;
				} else {
					startCount.push(start);
					endCount.push(end);
					segCount++;
					start = c;
					end = c;
				}
			}
			startCount.push(start);
			endCount.push(end);
			segCount++;
		}
		
		// Add end segment
		if(endCount.length == 0 || endCount[endCount.length-1] != 0xFFFF) {
			startCount.push(0xFFFF);
			endCount.push(0xFFFF);
			segCount++;
		}
		
		var segCountX2 = segCount * 2;
		var searchRange = 2 * Math.pow(2, Math.floor(Math.log(segCount)/Math.log(2)));
		var entrySelector = Math.floor(Math.log(segCount)/Math.log(2));
		var rangeShift = segCountX2 - searchRange;
		
		// Calculate deltas and offsets
		for(var i=0; i<segCount; i++) {
			var start = startCount[i];
			var end = endCount[i];
			
			if(start == 0xFFFF) {
				idDelta.push(1);
				idRangeOffset.push(0);
				continue;
			}
			
			// Try to use idDelta
			var gidStart = charToGlyph[start];
			var delta = gidStart - start;

			idDelta.push(delta);
			idRangeOffset.push(0);
		}
		
		// Serialize
		var length = 16 + segCount*8; // Header + arrays
		var buf = new ArrayBuffer(length);
		var view = new DataView(buf);
		
		view.setUint16(0, 4); // Format
		view.setUint16(2, length);
		view.setUint16(4, 0); // Language
		view.setUint16(6, segCountX2);
		view.setUint16(8, searchRange);
		view.setUint16(10, entrySelector);
		view.setUint16(12, rangeShift);
		
		var offset = 14;
		for(var i=0; i<segCount; i++) { view.setUint16(offset, endCount[i]); offset+=2; }
		view.setUint16(offset, 0); offset+=2; // ReservedPad
		for(var i=0; i<segCount; i++) { view.setUint16(offset, startCount[i]); offset+=2; }
		for(var i=0; i<segCount; i++) { view.setUint16(offset, idDelta[i]); offset+=2; }
		for(var i=0; i<segCount; i++) { view.setUint16(offset, idRangeOffset[i]); offset+=2; }
		
		// Wrap in Table Directory format for cmap
		// We need a platform 3 encoding 1 table (Windows Unicode)
		var cmapLen = 4 + 8 + length;
		var cmapBuf = new ArrayBuffer(cmapLen);
		var cmapView = new DataView(cmapBuf);
		
		cmapView.setUint16(0, 0); // Version
		cmapView.setUint16(2, 1); // NumTables
		
		cmapView.setUint16(4, 3); // PlatformID (Windows)
		cmapView.setUint16(6, 1); // EncodingID (Unicode BMP)
		cmapView.setUint32(8, 12); // Offset
		
		var subtableView = new Uint8Array(buf);
		var cmapBytes = new Uint8Array(cmapBuf);
		cmapBytes.set(subtableView, 12);
		
		return new DataView(cmapBuf);
	}
	
	function createCmapFormat12(chars, charToGlyph) {
		// Format 12: Segmented coverage
		var groups = [];
		
		if(chars.length > 0) {
			var start = chars[0];
			var end = chars[0];
			var startGid = charToGlyph[start];
			
			for(var i=1; i<chars.length; i++) {
				var c = chars[i];
				var gid = charToGlyph[c];
				var prevC = chars[i-1];
				var prevGid = charToGlyph[prevC];
				
				if(c == prevC + 1 && gid == prevGid + 1) {
					end = c;
				} else {
					groups.push({start: start, end: end, startGid: startGid});
					start = c;
					end = c;
					startGid = gid;
				}
			}
			groups.push({start: start, end: end, startGid: startGid});
		}
		
		var numGroups = groups.length;
		var length = 16 + numGroups * 12;
		var buf = new ArrayBuffer(length);
		var view = new DataView(buf);
		
		view.setUint16(0, 12); // Format
		view.setUint16(2, 0); // Reserved
		view.setUint32(4, length);
		view.setUint32(8, 0); // Language
		view.setUint32(12, numGroups);
		
		var offset = 16;
		for(var i=0; i<numGroups; i++) {
			view.setUint32(offset, groups[i].start); offset+=4;
			view.setUint32(offset, groups[i].end); offset+=4;
			view.setUint32(offset, groups[i].startGid); offset+=4;
		}
		
		// Wrap in Table Directory
		// Platform 3, Encoding 10 (Windows Unicode Full)
		var cmapLen = 4 + 8 + length;
		var cmapBuf = new ArrayBuffer(cmapLen);
		var cmapView = new DataView(cmapBuf);
		
		cmapView.setUint16(0, 0);
		cmapView.setUint16(2, 1);
		
		cmapView.setUint16(4, 3);
		cmapView.setUint16(6, 10);
		cmapView.setUint32(8, 12);
		
		var subtableView = new Uint8Array(buf);
		var cmapBytes = new Uint8Array(cmapBuf);
		cmapBytes.set(subtableView, 12);
		
		return new DataView(cmapBuf);
	}
	
	function createPost(font) {
		var buf = new ArrayBuffer(32);
		var view = new DataView(buf);
		
		var post = font.post || {};
		
		view.setUint32(0, 0x00030000); // Version 3.0
		
		// italicAngle
		var italicAngle = post.italicAngle || 0;
		// Convert float to Fixed (16.16)
		var mantissa = Math.floor(italicAngle);
		var fraction = Math.floor((italicAngle - mantissa) * 65536);
		view.setInt16(4, mantissa);
		view.setUint16(6, fraction);
		
		view.setInt16(8, post.underlinePosition || 0);
		view.setInt16(10, post.underlineThickness || 0);
		
		view.setUint32(12, post.isFixedPitch || 0);
		
		// Memory usage fields (set to 0)
		view.setUint32(16, 0);
		view.setUint32(20, 0);
		view.setUint32(24, 0);
		view.setUint32(28, 0);
		
		return view;
	}
	
	function createFont(tables) {
		var tableTags = Object.keys(tables);
		var numTables = tableTags.length;
		
		// Calculate offsets
		var headerSize = 12 + numTables * 16;
		var offset = headerSize;
		var tableRecords = [];
		
		// Sort tags
		tableTags.sort();
		
		for(var i=0; i<numTables; i++) {
			var tag = tableTags[i];
			var data = tables[tag];
			if(!data) continue;
			
			var len = data.byteLength;
			var padding = (4 - (len % 4)) % 4;
			
			// Checksum
			var checksum = calcChecksum(data);
			
			tableRecords.push({
				tag: tag,
				checksum: checksum,
				offset: offset,
				length: len,
				padding: padding,
				data: data
			});
			
			offset += len + padding;
		}
		
		var totalSize = offset;
		var buf = new ArrayBuffer(totalSize);
		var view = new DataView(buf);
		
		// Header
		view.setUint32(0, 0x00010000); // Version 1.0
		view.setUint16(4, numTables);
		
		var searchRange = 16 * Math.pow(2, Math.floor(Math.log(numTables)/Math.log(2)));
		view.setUint16(6, searchRange);
		view.setUint16(8, Math.floor(Math.log(numTables)/Math.log(2)));
		view.setUint16(10, numTables * 16 - searchRange);
		
		// Table Records
		var recOffset = 12;
		for(var i=0; i<tableRecords.length; i++) {
			var rec = tableRecords[i];
			writeTag(view, recOffset, rec.tag);
			view.setUint32(recOffset+4, rec.checksum);
			view.setUint32(recOffset+8, rec.offset);
			view.setUint32(recOffset+12, rec.length);
			recOffset += 16;
		}
		
		// Table Data
		var bytes = new Uint8Array(buf);
		for(var i=0; i<tableRecords.length; i++) {
			var rec = tableRecords[i];
			var dataBytes = new Uint8Array(rec.data.buffer, rec.data.byteOffset, rec.data.byteLength);
			bytes.set(dataBytes, rec.offset);
			// Padding is zero by default
		}
		
		// Calc full checksum (head table adjustment)
		// We need to set checkSumAdjustment in head table to 0 first (it is already 0 in our copy?)
		
		var headRec = tableRecords.find(r => r.tag == "head");
		if(headRec) {
			var headOffset = headRec.offset;
			view.setUint32(headOffset + 8, 0); // checkSumAdjustment is at offset 8 in head
			
			// Zero adjustment in buffer
			view.setUint32(headOffset + 8, 0);
			
			// Recalculate head table checksum
			var headData = new DataView(buf, headOffset, headRec.length);
			var newHeadChecksum = calcChecksum(headData);
			
			// Update head record checksum
			var headRecIdx = tableTags.indexOf("head");
			view.setUint32(12 + headRecIdx*16 + 4, newHeadChecksum);
			
			// Calculate whole font checksum
			var wholeChecksum = calcChecksum(new DataView(buf));
			var adjustment = (0xB1B0AFBA - wholeChecksum) >>> 0;
			
			// Write adjustment
			view.setUint32(headOffset + 8, adjustment);
		}
		
		return buf;
	}
	
	function calcChecksum(data) {
		var sum = 0;
		var len = data.byteLength;
		for(var i=0; i<len; i+=4) {
			// Treat as uint32
			if(i + 4 <= len) {
				sum = (sum + data.getUint32(i)) >>> 0;
			} else {
				// Handle remaining bytes
				var v = 0;
				v |= data.getUint8(i) << 24;
				if(i+1 < len) v |= data.getUint8(i+1) << 16;
				if(i+2 < len) v |= data.getUint8(i+2) << 8;
				sum = (sum + v) >>> 0;
			}
		}
		return sum;
	}
	
	function writeTag(view, offset, tag) {
		for(var i=0; i<4; i++) view.setUint8(offset+i, tag.charCodeAt(i));
	}
	
	return { write: write };
})();
