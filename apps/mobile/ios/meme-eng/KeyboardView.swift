import SwiftUI

struct KeyboardView: View {

    var onInsertText: (String) -> Void
    var onDelete: () -> Void

    @State private var isLoading = false
    @State private var imageUrls: [String] = []

    var body: some View {

        VStack(spacing: 16) {

            HStack {

                Text("meme")
                    .font(.headline)

                Spacer()

                Button("😂") {
                    onInsertText("😂")
                }
            }

            Button {

                Task {
                    await fetchImages()
                }

            } label: {

                Text(
                    isLoading
                    ? "Generating..."
                    : "Generate Images"
                )
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(isLoading)

            if !imageUrls.isEmpty {

                ScrollView(.horizontal, showsIndicators: false) {

                    HStack(spacing: 12) {

                        ForEach(imageUrls, id: \.self) { imageUrl in

                            AsyncImage(
                                url: URL(string: imageUrl)
                            ) { image in

                                image
                                    .resizable()
                                    .scaledToFill()

                            } placeholder: {

                                ProgressView()
                            }
                            .frame(width: 120, height: 120)
                            .clipShape(
                                RoundedRectangle(cornerRadius: 12)
                            )
                        }
                    }
                }
            }

            HStack {

                Button("Hello") {
                    onInsertText("Hello ")
                }

                Button("World") {
                    onInsertText("World ")
                }

                Button("Delete") {
                    onDelete()
                }
            }
            .buttonStyle(.bordered)
        }
        .padding()
        .frame(height: 320)
        .background(
            Color(.systemBackground)
        )
    }

    func fetchImages() async {

        isLoading = true

        do {

            let images = try await APIService.shared.generateImages()

            imageUrls = images

        } catch {

            print(error)
        }

        isLoading = false
    }
}
