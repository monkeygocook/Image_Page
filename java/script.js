const image = document.querySelector(".ai-image");
const modal = document.getElementById("imageModal");
const modalImage = document.getElementById("modalImage");
const close = document.querySelector(".close");

// คลิกที่รูป Output
image.addEventListener("click", function () {

    modal.style.display = "flex";

    modalImage.src = image.src;

});


// คลิกตรงไหนก็ได้ใน Modal เพื่อปิด
modal.addEventListener("click", function () {

    modal.style.display = "none";

});