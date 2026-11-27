# Đề xuất Nâng cấp Tính năng cho LN-Studio (Feature Research)

Tài liệu tổng hợp các cơ chế thiết kế hiệu quả phù hợp với kiến trúc FastAPI + SQLite + React của **LN-Studio**, chia theo 4 nhóm tính năng trọng tâm.

---

## 1. Tách, Quản lý & Giữ vị trí Ảnh EPUB dạng Markdown

### Vấn đề hiện tại
- `epub_service.py` mới chỉ trích xuất văn bản và `<ruby>`, chưa giữ lại tranh minh họa (illustrations) trong Light Novel EPUB.

### Đề xuất áp dụng cho LN-Studio
1. **Trích xuất ảnh khi nhập EPUB**:
   - Khi duyệt DOM chương EPUB, bắt đầy đủ thẻ `<img>`, `<image>`, `<svg:image>` (`src`, `href`, `xlink:href`) cả đứng độc lập lẫn nằm trong `<p>`/`<div>`.
   - Kiểm tra định dạng ảnh hợp lệ (`JPEG/PNG/GIF/WEBP` bằng Pillow), đặt tên theo hash SHA-256 ngắn để chống lưu trùng, lưu vào `data/media/series_{series_id}/vol_{vol_num}/`.
   - Chèn trực tiếp vào `chapters.raw_text` đúng vị trí xuất hiện bằng cú pháp Markdown chuẩn: `![alt](/api/media/series_{id}/vol_{n}/{filename})`.
2. **Bảo toàn vị trí ảnh khi dịch bằng Marker (`[[IMAGE_001]]`)**:
   - Trước khi gửi prompt sang Gemini, thay mọi cú pháp `![...](...)` thành mã giữ chỗ tuần tự `[[IMAGE_001]]`, `[[IMAGE_002]]` và chèn chỉ thị yêu cầu AI giữ đúng mã, đúng thứ tự, không dịch/xóa/nhân bản.
   - Sau khi AI trả kết quả, kiểm tra nghiêm ngặt: danh sách mã đầu ra phải khớp chính xác `list(images)` và AI không được tự sinh thêm link ảnh lạ; đạt chuẩn mới khôi phục lại Markdown ảnh vào `translated_text`.
3. **Kệ ảnh (Image Shelf) & Xuất bản kèm ảnh**:
   - Cho phép xem danh sách ảnh của Tập, biết ảnh đang gắn ở những chương nào, tải thêm ảnh mới và chèn nhanh vào chương.
   - Hiển thị preview ảnh ngay trong `ProofreadTab` và tự động nhúng ảnh thật vào `.docx` / `.epub` khi xuất bản.

---

## 2. Quản lý Dịch Nội dung Nhạy cảm / R19 & Thay thế Từ có Hoàn nguyên

### Vấn đề hiện tại
- `mask_service.py` hiện thay cụm nhạy cảm bằng cụm nhẹ nhàng cố định (giữ nguyên cụm đã thay sau khi dịch). Với các cảnh nhạy cảm/R19, người dịch thường muốn **vượt qua bộ lọc khi dịch nhưng vẫn khôi phục đúng sắc thái tiếng Việt** sau khi dịch xong.

### Đề xuất áp dụng cho LN-Studio
1. **Bổ sung chế độ Che giữ chỗ & Hoàn nguyên (Mask → Translate → Restore)** song song với chế độ thay nhẹ hiện có:
   - Mở rộng bảng `sensitive_masks` thêm cột `mode` (`soft_replace` | `token_restore`) và `vi_translation` (cache bản dịch Việt của cụm nhạy cảm).
   - **Masking đồng bộ cả Chương lẫn Ngữ cảnh**: thay mọi cụm khớp (ưu tiên chuỗi dài nhất, không phân biệt hoa/thường) thành mã `__MASK_0001__` trong cả `title`, `raw_text` và `Rolling Context` (chương trước), tránh trường hợp từ nhạy cảm còn sót trong ngữ cảnh nối tiếp làm chặn chương hiện tại.
2. **Dịch riêng từng mảnh chưa có cache**:
   - Chỉ gọi 1 request JSON gọn (`{"translation": "..."}`) không kèm ngữ cảnh dài bằng model nhẹ cho các cụm chưa có `vi_translation`, sau đó lưu cache vào SQLite để tái sử dụng ở các chương/tập sau.
3. **Hoàn nguyên thông minh sau dịch**:
   - Chuẩn hóa biến thể AI hay làm lệch mã (VD: `\_`, `**MASK_0001**`, đổi hoa/thường).
   - Kiểm tra bắt buộc không thiếu bất kỳ mã giữ chỗ nào; nếu thiếu thì báo lỗi/thử lại trước khi lưu.
   - Tự động **viết hoa chữ cái đầu** khi mã nằm ở đầu câu/đầu dòng/sau dấu `.?!…“—`, và áp dụng Title Case khi nằm ở tiêu đề chương.

---

## 3. Cấu hình Chọn Model & Mức Tư duy theo từng Tác vụ

### Vấn đề hiện tại
- `GeminiPool` hiện dùng chung một danh sách `model_priority` duy nhất cho mọi tác vụ (dịch văn học, đếm/dịch thuật ngữ, MAP/REDUCE, quét từ nhạy cảm...).

### Đề xuất áp dụng cho LN-Studio
1. **Bảng ánh xạ Model theo Tác vụ (`task_models` trong `app_settings`)**:
   - Cho phép gán chuỗi model ưu tiên (fallback) + `thinking_level` (`off` / `low` / `medium` / `high`) riêng cho từng nhóm tác vụ, vẫn dùng chung hạ tầng xoay key & tracking `quota_slots` của `GeminiPool`:
     - `translate`: Dịch chương chính (ưu tiên chất lượng cao, VD `gemini-2.5-pro` → `gemini-2.5-flash`).
     - `glossary`: Dịch batch từ mới Master Glossary (`gemini-2.5-flash`).
     - `continuity`: MAP PHASE & REDUCE tóm tắt + trích xuất xưng hô (`gemini-2.5-flash` / `flash-lite`).
     - `proofread_review`: Soát lỗi tự động, hậu dịch, sửa sót ngoại ngữ (`gemini-2.5-flash-lite` / `flash`).
     - `sensitive_mask`: Quét & dịch mảnh từ nhạy cảm (`gemini-2.5-flash-lite`).
2. **Giao diện cấu hình trực quan trong `Cài đặt → Model ưu tiên`**:
   - Giữ danh sách fallback mặc định ở trên, thêm bảng chọn model ưu tiên + thinking level cho từng tác vụ bên dưới (kèm nút chọn nhanh preset *"Tiết kiệm Quota"* và *"Chất lượng Tối đa"*).
   - Cho phép truyền `task_type="translate" | "glossary" | ...` vào `gemini_pool.generate_content(...)` để tự động lấy đúng cấu hình model & thinking.

---

## 4. Quản lý Kho Chương & Trải nghiệm Hiệu đính Nâng cao

### Đề xuất áp dụng cho LN-Studio
1. **Tự động kiểm tra & sửa sót ký tự ngoại ngữ (Foreign-Char Guard)**:
   - Sau khi dịch xong (hoặc chạy soát hàng loạt trên tập), quét regex phát hiện ký tự Nhật/Trung/Hàn còn sót trong `translated_text` (bỏ qua chú thích nếu cần).
   - Cho phép tự động gọi AI sửa lại tối đa `fix_max_retry` lần; nếu vẫn sót thì đánh dấu cờ `needs_manual_check` để biên tập viên lọc nhanh trong `ProofreadTab`.
2. **Phiên Hiệu đính AI dạng Diff theo từng đoạn (Non-Destructive Polish Review)**:
   - Khi dùng AI trau chuốt/hiệu đính cả chương, **không ghi đè trực tiếp** `chapters.translated_text`.
   - Lưu bản đề xuất tách khối so sánh theo đoạn văn (`difflib.SequenceMatcher`), hiển thị Diff Old/New từng đoạn cho biên tập viên chọn Giữ bản gốc / Nhận bản mới / Sửa tay, kèm kiểm tra `revision` chống xung đột khi người dùng sửa song song.
3. **Tìm kiếm Toàn Tập có Ngữ cảnh & Nhảy thẳng tới vị trí**:
   - Nâng cấp công cụ tìm kiếm trong `ProofreadTab`: cho chọn phạm vi `Raw` / `Bản dịch` / `Cả hai`, hỗ trợ `Whole Word` (chuẩn Unicode) và `Case-Sensitive`, trả về danh sách kết quả kèm đoạn văn trước–sau; bấm vào kết quả sẽ nhảy đúng chương và bôi đen vị trí khớp.
4. **Cải tiến Kho Truyện, Nhập lại Chương & Định dạng Xuất bản**:
   - **Xem trước & So khớp khi nhập lại (Import Preview + Anchor Matching)**: khi nhập bản cập nhật mới, tự so khớp tiêu đề + nội dung chương bằng `SequenceMatcher` để biết chương nào đã có, chương nào mới thêm, tránh ghi đè nhầm chương đã dịch.
   - **Ẩn / Lưu trữ truyện đã hoàn thành** trên Dashboard (toggle "Hiện truyện đã ẩn") để gọn danh sách khi dịch nhiều bộ.
   - **Hỗ trợ Markdown nhấn mạnh (`**đậm**`, `*nghiêng*`, `***đậm nghiêng***`)** trong `export_service.py`: chuyển đổi an toàn thành run Bold/Italic thật trong `.docx` và `<strong>`/`<em>` trong `.epub` thay vì để thô dấu `*`.

---

## Đề xuất Thứ tự Ưu tiên Triển khai (nếu duyệt)
1. **Nhóm 3 (Model theo tác vụ)** — tác động thấp, tiết kiệm quota ngay lập tức.
2. **Nhóm 1 (Ảnh EPUB Markdown + `[[IMAGE_001]]` Marker + Xuất có ảnh)** — giá trị cao nhất cho Light Novel.
3. **Nhóm 2 (Nâng cấp R19 Token Restore + Cache bản dịch mảnh)** — giải quyết triệt để chương nhạy cảm.
4. **Nhóm 4 (Foreign-Char Check, Diff Polish Review, Context Search, Bold/Italic Export, Archive Series)** — hoàn thiện trải nghiệm biên tập chuyên sâu.
