//region Femboy

let linkar = document.getElementById("agroboy")
let redirectOnClose = false;

// Função para mostrar o modal de confirmação
function link() {
    document.getElementById("custom-modal").style.display = "block";
}

// Função para quando clicar em "Sim"
function confirmAction() {
    document.getElementById("custom-modal").style.display = "none"; // Fecha o modal de pergunta
    
    // Configura e abre o modal de resposta
    document.getElementById("message-text").innerText = "iiiiiiiiii Qui História é Essa Baitolão";
    document.getElementById("message-modal").style.display = "block";
    redirectOnClose = true; // Marca para redirecionar quando fechar
}

// Função para quando clicar em "Não" (fechar o modal)
function closeModal() {
    document.getElementById("custom-modal").style.display = "none"; // Fecha o modal de pergunta
    
    // Configura e abre o modal de resposta
    document.getElementById("message-text").innerText = "Parabens Você Passou No Teste Seu Baitolão";
    document.getElementById("message-modal").style.display = "block";
    redirectOnClose = false; // Não redireciona, apenas fecha
}

// Nova função para fechar o modal de mensagem e agir
function closeMessageModal() {
    document.getElementById("message-modal").style.display = "none";
    
    if (redirectOnClose) {
        window.location.href = "https://www.bing.com/images/search?q=astolfo&form=HDRSC3&first=1";
    }
}

// Fechar os modais se clicar fora deles
window.onclick = function(event) {
    let modalQuestion = document.getElementById("custom-modal");
    let modalMessage = document.getElementById("message-modal");
    
    if (event.target == modalQuestion) {
        modalQuestion.style.display = "none";
    }
    if (event.target == modalMessage) {
        modalMessage.style.display = "none";
    }
}

//#endregion femboy
